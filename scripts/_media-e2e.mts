// Live E-311 check on SANDBOX: real S3, real models, real tools, real DB.
// Previews only; each proposed write is applied inside a transaction that is ROLLED BACK.
// Leaves nothing behind: test cards are cancelled and test attachments retired
// (the S3 objects stay, under documents/wa-assistant/<Nidhi's id>/).
//
//   node --import tsx --env-file=.env.local scripts/_media-e2e.mts <dir with card2.jpg, gst.pdf, gst_tiger.pdf>
import { readFileSync } from "node:fs";
import postgres from "postgres";
const { db } = await import("@/lib/db");
const { sql } = await import("drizzle-orm");
const M = await import("@/lib/assistant/media");
const { runAgentTurn, createToolCallingModel, createBackupToolCallingModel } = await import("@/lib/assistant/agent");
const { toolsFor } = await import("@/lib/assistant/registry");
const { buildSystemPrompt } = await import("@/lib/assistant/prompt");
const { APPLIERS } = await import("@/lib/assistant/appliers");
const { assistantConfig } = await import("@/lib/assistant/config");
const D = process.argv[2];
const user = { id: "4976e51b-15a1-4e83-8dff-d776d4fe7416", name: "Nidhi", role: "inside_sales_rep" as const };
const cfg = assistantConfig();
const tools = toolsFor(user.role, true);
const now = new Date();
const model = createToolCallingModel({ model: cfg.model, apiKey: cfg.apiKey!, tools });
const backupModel = createBackupToolCallingModel({ model: cfg.backupModel, apiKey: cfg.openRouterApiKey!, tools });
const created: { media: string[]; actions: string[] } = { media: [], actions: [] };

async function turn(label: string, file: string, mime: string, kind: "image" | "document", caption: string | null) {
  const row = await M.storeMediaFile({ userId: user.id, sourceMessageId: null, kind, bytes: readFileSync(`${D}/${file}`), mimeType: mime, fileName: kind === "document" ? file : null, caption });
  created.media.push(row.id);
  const back = await M.mediaBytes(row);
  console.log(`\n=== ${label}: stored ${row.ref} (${row.byte_size} B) → S3 round-trip ${back?.length === row.byte_size ? "OK" : "MISMATCH"}`);
  const pending = await M.pendingMedia(user.id);
  const ctx = M.pendingMediaContext(pending)!;
  const calls: { tool: string; input: unknown; ok: boolean; output: unknown }[] = [];
  const t0 = Date.now();
  const out = await runAgentTurn(
    { system: buildSystemPrompt({ user, now, tools: tools.map((x) => x.name), writesEnabled: true }), history: [], userText: `${ctx}\n${caption ?? "(no text — only the attachments above)"}` },
    { model, backupModel, tools, ctx: { user, messageId: null, now, writesEnabled: true }, logToolCall: async (r) => { calls.push({ tool: r.tool, input: r.input, ok: r.ok, output: r.output }); } },
  );
  console.log(`${Date.now() - t0}ms, modelCalls ${out.modelCalls}, backup ${out.usedBackup}`);
  for (const c of calls) console.log(`  → ${c.tool}(${JSON.stringify(c.input)}) ok=${c.ok}\n     ${JSON.stringify(c.output).slice(0, 420)}`);
  console.log(`  reply: ${out.text.replace(/\n/g, " | ").slice(0, 300)}`);
  for (const r of out.results) if (r.result.kind === "preview") created.actions.push(r.result.action_id);
}

try {
  await turn("A. visiting card of a NEW dealer, no caption", "card2.jpg", "image/jpeg", "image", null);
  await turn("B. the WRONG dealer's GST certificate (Sharma, Pune) captioned as TIGER's", "gst.pdf", "application/pdf", "document", "TIGER BATTERY ka GST");
  // retire earlier files so each turn only sees its own
  await (await import("postgres")).default(process.env.DATABASE_URL!, { max: 1, ssl: "require" })`update assistant_media set used_at = now() where id = any(${created.media}::uuid[])`;
  await turn("C. TIGER BATTERY's own GST certificate (Kanpur)", "gst_tiger.pdf", "application/pdf", "document", "TIGER BATTERY ka GST");

  // Apply each proposed action for real, then roll back.
  const raw = postgres(process.env.DATABASE_URL!, { max: 1, ssl: "require" });
  for (const id of created.actions) {
    const [a] = await raw`select tool, lead_id, input from assistant_actions where id = ${id}`;
    const applier = APPLIERS[a.tool as keyof typeof APPLIERS];
    const plan = applier.schema.parse(a.input);
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.actor_id', ${user.id}, true)`);
        const out = await applier.apply({ tx, user, step: 1, actionId: id }, plan);
        const leadId = (out.lead_id as string) ?? a.lead_id;
        const docs = await tx.execute(sql`select doc_type, storage_key, source from dealer_lead_documents where dealer_lead_id = ${leadId}`);
        const lead = await tx.execute(sql`select id, dealer_name, shop_name, city, state, area, pincode, contact_email, gstin, location from dealer_leads where id = ${leadId}`);
        const used = await tx.execute(sql`select ref, used_at is not null as used, used_by_action_id::text = ${id} as by_this from assistant_media where id = any(${`{${created.media.join(",")}}`}::uuid[])`);
        const audit = await tx.execute(sql`select field, old_value, new_value, changed_by::text = ${user.id} as by_nidhi from dealer_lead_field_changes where dealer_lead_id = ${leadId} and changed_at > now() - interval '1 minute'`).catch(() => [] as unknown[]);
        console.log(`\n=== APPLY ${a.tool} (${id.slice(0, 8)}) — inside a transaction, then ROLLBACK`);
        console.log("  lead:", JSON.stringify(lead[0]));
        console.log("  documents:", JSON.stringify(docs));
        console.log("  media:", JSON.stringify(used));
        console.log("  field audit (E-304):", JSON.stringify(audit));
        throw new Error("__rollback__");
      });
    } catch (e) { if ((e as Error).message !== "__rollback__") console.log("  APPLY FAILED:", (e as Error).message); }
  }
  await raw.end();
} finally {
  // Leave nothing behind: cancel the test cards, retire the test attachments.
  const raw = postgres(process.env.DATABASE_URL!, { max: 1, ssl: "require" });
  if (created.actions.length) await raw`update assistant_actions set status='cancelled', error='e2e test', updated_at=now() where id = any(${created.actions}::uuid[]) and status='pending'`;
  if (created.media.length) await raw`update assistant_media set used_at = now() where id = any(${created.media}::uuid[]) and used_at is null`;
  const chk = await raw`select count(*)::int n from dealer_leads where phone like '%9711248653'`;
  console.log(`\ncleanup: ${created.actions.length} test card(s) cancelled, ${created.media.length} test attachment(s) retired; test lead in DB: ${chk[0].n}`);
  await raw.end();
  process.exit(0);
}
