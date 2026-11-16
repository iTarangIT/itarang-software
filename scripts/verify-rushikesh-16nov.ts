// Sandbox check for the 16 Nov batch (IDs 233, 235, 238, 224). Read-mostly:
// it creates its own TEST leads (no status, no owner) and closes them as
// "Test lead", which takes them out of every count — nothing else is written.
// Refuses live (database-2).
//
//   node --import tsx --env-file=.env.local scripts/verify-rushikesh-16nov.ts
//
// Uses the app's own code: markLeadLost, the dedupe classifier, reactivateLead,
// the NeoDove campaign reads, the WhatsApp Skip helpers.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { markLeadLost, TestLeadRoleError } from "@/lib/leads/markLost";
import { classifyAgainstExisting, loadExistingByPhone } from "@/lib/leads/dedupe";
import { reactivateLead, TestLeadReopenError } from "@/lib/leads/reactivation";
import { canMarkUnownedLeadLost } from "@/lib/leads/access";
import { leadNeodoveCampaign, movePreview, neodoveCampaignLine, ownerNeodoveCampaign } from "@/lib/neodove/leadCampaign";
import { docRequestSkipButtons, isDocSkip, withSkipLine } from "@/lib/whatsapp/doc-buttons";
import { docTypeLabel } from "@/lib/whatsapp/checklist";

function check(ok: boolean, what: string) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) process.exitCode = 1;
}

type Id = { id: string };
const one = async <T,>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as T[])[0];

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    if (host.startsWith("database-2")) throw new Error("refusing to run against live (database-2)");
    console.log(`DB host: ${host}\n`);

    // ── ID 233 ───────────────────────────────────────────────────────────
    console.log("ID 233 — Mark lost for leads with no status or owner; 'Test lead'");
    const ceo = await one<Id>(sql`SELECT id::text AS id FROM users WHERE role = 'ceo' AND is_active LIMIT 1`);
    const isr = await one<Id>(sql`SELECT id::text AS id FROM users WHERE role = 'inside_sales_rep' AND is_active LIMIT 1`);
    if (!ceo || !isr) throw new Error("need an active CEO and ISR on the sandbox");
    const stamp = Date.now();
    const leads = [0, 1, 2].map((i) => ({ id: `TEST-233b-${stamp.toString(36)}-${i}`, phone: `8${String(stamp + i).slice(-9)}` }));
    for (const l of leads) {
        await db.execute(sql`
            INSERT INTO dealer_leads (id, dealer_name, shop_name, phone, lead_status, current_owner_id, created_at, updated_at)
            VALUES (${l.id}, 'TEST 233 no-status lead', 'TEST 233', ${l.phone}, NULL, NULL, NOW(), NOW())
        `);
    }
    console.log(`  created ${leads.length} leads with no status and no owner`);

    check(canMarkUnownedLeadLost("ceo") && canMarkUnownedLeadLost("sales_head") && canMarkUnownedLeadLost("admin"), "Admin, Sales Head, CEO may close an ownerless lead");
    check(!canMarkUnownedLeadLost("inside_sales_rep") && !canMarkUnownedLeadLost("asm"), "an ISR or ASM may not");

    let refused = false;
    try {
        await markLeadLost({ leadId: leads[0].id, actor: { id: isr.id, role: "inside_sales_rep" }, reason: "test_lead", notes: "x" });
    } catch (e) {
        refused = e instanceof TestLeadRoleError;
    }
    check(refused, "an ISR cannot give 'Test lead'");

    // The bulk route now sends a no-status lead to the same writer (it used to skip it).
    for (const l of leads) {
        await markLeadLost({ leadId: l.id, actor: { id: ceo.id, role: "ceo" }, reason: "test_lead", notes: "TEST 233 bulk", closingRole: "admin" });
    }
    const after = (await db.execute(sql`
        SELECT lead_status, lost_reason, is_active FROM dealer_leads WHERE id IN (${sql.join(leads.map((l) => sql`${l.id}`), sql`, `)})
    `)) as unknown as Array<{ lead_status: string; lost_reason: string; is_active: boolean }>;
    check(after.length === 3 && after.every((r) => r.lead_status === "Lost" && r.lost_reason === "test_lead" && r.is_active === false),
        "3 no-status leads marked lost as Test lead (and out of the counts)");

    // A NeoDove LEAD_CREATE / upload / AI recall on the same number must not reopen it.
    const existing = await loadExistingByPhone([`+91${leads[0].phone}`]);
    const verdict = classifyAgainstExisting("", existing.get(`+91${leads[0].phone}`));
    check(verdict.outcome === "duplicate_skip" && verdict.duplicateLeadId === leads[0].id, `a NeoDove / upload row for its number is a duplicate, not a reopen (${verdict.outcome})`);
    for (const trigger of ["upload", "ai_dialer"] as const) {
        let blocked = false;
        try {
            await reactivateLead({ leadId: leads[0].id, trigger, performedBy: null });
        } catch (e) {
            blocked = e instanceof TestLeadReopenError;
        }
        check(blocked, `${trigger} cannot reopen a test lead`);
    }
    const still = await one<{ lead_status: string }>(sql`SELECT lead_status FROM dealer_leads WHERE id = ${leads[0].id}`);
    check(still?.lead_status === "Lost", "the test lead is still Lost");

    // ── ID 235 ───────────────────────────────────────────────────────────
    console.log("\nID 235 — NeoDove campaign on the lead; Reassign offers to move it");
    const linked = await one<{ dealer_lead_id: string }>(sql`
        SELECT dealer_lead_id FROM neodove_lead_links WHERE push_status = 'pushed' ORDER BY pushed_at DESC NULLS LAST LIMIT 1
    `);
    if (linked) {
        const c = await leadNeodoveCampaign(linked.dealer_lead_id);
        const line = neodoveCampaignLine(c, (d) => d.slice(0, 10));
        console.log(`  ${linked.dealer_lead_id}: "NeoDove campaign: ${line}"`);
        check(!!c && /, sent \d{4}-\d{2}-\d{2}$/.test(line), "the lead page line names the campaign and the date sent");
        const owners = (await db.execute(sql`
            SELECT to_jsonb(c) ->> 'crm_owner_user_id' AS owner, c.id FROM neodove_campaigns c
             WHERE to_jsonb(c) ->> 'crm_owner_user_id' IS NOT NULL AND c.push_endpoint_ref IS NOT NULL AND c.status <> 'completed'
        `)) as unknown as Array<{ owner: string; id: string }>;
        const other = owners.find((o) => o.id !== c?.campaign_id);
        if (other) {
            const p = movePreview(c, await ownerNeodoveCampaign(other.owner));
            check(p.offer, "Reassign to an ISR with their own campaign offers 'Also move'");
        } else {
            console.log("  (no second campaign with a CRM owner on this DB — 'Also move' offer not exercised)");
        }
        const self = c ? owners.find((o) => o.id === c.campaign_id) : undefined;
        if (self) check(!movePreview(c, await ownerNeodoveCampaign(self.owner)).offer || false, "same campaign → no offer");
    } else {
        console.log("  (no pushed NeoDove lead on this DB)");
    }
    check(neodoveCampaignLine(null, (d) => d) === "Not sent to NeoDove", "a lead never pushed reads 'Not sent to NeoDove'");

    // ── ID 238 ───────────────────────────────────────────────────────────
    console.log("\nID 238 — WhatsApp onboarding: Skip on each document");
    const ask = withSkipLine("📄 Please send your *Bank statement* (last 6 months).");
    check(/Tap Skip/.test(ask) && docRequestSkipButtons()[0].title.includes("Skip"), "each document request carries the Skip line and button");
    check(isDocSkip(docRequestSkipButtons()[0].id) && isDocSkip("skip"), "a tap (docs_skip) or typed 'skip' is a Skip");
    check(withSkipLine("x".repeat(2000)).length <= 1024, "the request stays inside WhatsApp's 1024-character body");
    const skippedApp = await one<{ id: string; skipped: string[] }>(sql`
        SELECT a.id, s.context -> 'skipped' AS skipped
          FROM dealer_onboarding_applications a
          JOIN whatsapp_onboarding_sessions s ON s.id = a.wa_session_id
         WHERE jsonb_typeof(s.context -> 'skipped') = 'array' AND jsonb_array_length(s.context -> 'skipped') > 0
         LIMIT 1
    `);
    if (skippedApp) {
        console.log(`  application ${skippedApp.id}: Dealer Validation shows "Skipped by dealer: ${skippedApp.skipped.map(docTypeLabel).join(", ")}"`);
    } else {
        console.log("  (no WhatsApp application with a skipped document on this DB yet)");
    }

    // ── ID 224 ───────────────────────────────────────────────────────────
    console.log("\nID 224 — NeoDove lead created after its own call");
    const left = await one<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM dealer_leads dl
         WHERE dl.source = 'neodove'
           AND dl.created_at > (SELECT min(t.performed_at) AT TIME ZONE 'UTC' FROM lead_touchpoints t
                                 WHERE t.dealer_lead_id = dl.id AND t.touchpoint_type <> 'lead_created')
    `);
    check((left?.n ?? -1) === 0, `NeoDove leads created after their own first call: ${left?.n}`);
}

main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((e) => {
        console.error(e instanceof Error ? e.stack : e);
        process.exit(1);
    });
