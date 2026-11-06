// One-off end-to-end test of Priya KPI task 10 (carrier-refusal pause, probe,
// pick-up; E-374) and the Dispositions v3 trigger path (E-373), against SANDBOX.
//
//   AGENTMAIL_API_KEY= SMTP_HOST= ELEVENLABS_API_KEY=e2e-stub \
//     node --import tsx --env-file=.env.local scripts/_e2e-task10-carrier-pause.ts
//
// global fetch is stubbed for the ElevenLabs outbound endpoint, so the REAL
// trigger / probe / advance code runs but no phone can ring: "refuse" answers
// like Vobiz refusing the INVITE (SIP 503), "accept" like a placed call. Every
// time a call is "placed" the campaign is taken out of 'running' at once, so
// the sandbox server's own poller cannot advance it with the real key.
// Creates 12 throwaway leads + a campaign; deletes everything at the end.
import { sql, inArray, eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { dealerLeads, dialerCampaigns, dialerCampaignLeads } from "../src/lib/db/schema";
import { createCampaign } from "../src/lib/queue/campaignTracker";
import { advanceCampaign } from "../src/lib/queue/advanceCampaign";
import { clearCarrierPause, resumeAfterProbe, runCarrierProbes } from "../src/lib/ai-dialer/lineHealth";

if (process.env.ELEVENLABS_API_KEY !== "e2e-stub") throw new Error("refusing: set ELEVENLABS_API_KEY=e2e-stub");
if (process.env.AGENTMAIL_API_KEY || process.env.SMTP_HOST) throw new Error("refusing: email is configured");
const host = new URL(process.env.DATABASE_URL!).host;
if (!host.startsWith("database-1.")) throw new Error(`refusing: not sandbox (${host.split(".")[0]})`);

// ── fetch stub ──────────────────────────────────────────────────────────────
let mode: "refuse" | "accept" = "refuse";
let outboundCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (/convai\/(sip-trunk|twilio)\/outbound-call/.test(url)) {
    outboundCalls++;
    if (mode === "refuse") {
      return new Response(JSON.stringify({ detail: { message: "INVITE failed: sip status: 503: Service Unavailable" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: true, conversation_id: `conv_e2e_${Date.now()}_${outboundCalls}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (/elevenlabs\.io/.test(url)) throw new Error(`e2e: unexpected ElevenLabs call ${url}`);
  return realFetch(input, init);
}) as typeof fetch;

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${detail}`}`);
};

const tag = `e2et10${Date.now().toString(36)}`;
const leadIds = Array.from({ length: 12 }, (_, i) => `${tag}_${i}`);
let campaignId: string | null = null;
const rowsOf = <T,>(r: unknown) => (Array.isArray(r) ? (r as T[]) : ((r as { rows: T[] }).rows ?? []));

async function state() {
  const [c] = await db.select().from(dialerCampaigns).where(eq(dialerCampaigns.id, campaignId!));
  const rows = await db.select().from(dialerCampaignLeads).where(eq(dialerCampaignLeads.campaign_id, campaignId!));
  const lh = rowsOf<Record<string, any>>(
    await db.execute(sql`SELECT * FROM dialer_campaign_line_health WHERE campaign_id = ${campaignId}`),
  )[0];
  const disp = rowsOf<{ rule_no: string; sip_code: number; l2: string }>(
    await db.execute(sql`SELECT rule_no, sip_code, l2 FROM ai_dial_dispositions WHERE campaign_id = ${campaignId}`),
  );
  const tps = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM lead_touchpoints WHERE dealer_lead_id LIKE ${tag + "%"}`),
  )[0].n;
  const alerts = rowsOf<{ n: number }>(
    // One alert = one emit: a bell row per recipient, all in the same second.
    await db.execute(sql`SELECT count(DISTINCT date_trunc('second', created_at))::int AS n FROM notifications
                          WHERE type = 'dialer.campaign_paused' AND data->>'campaignId' = ${campaignId}`),
  )[0].n;
  return { c, rows, lh, disp, tps, alerts };
}

/** Take the campaign out of 'running' so nothing else can advance it. */
async function freeze(status: "paused" | "cancelled" = "paused") {
  await db.update(dialerCampaigns).set({ status }).where(eq(dialerCampaigns.id, campaignId!));
  await db
    .update(dialerCampaignLeads)
    .set({ status: "completed", completed_at: new Date(), call_outcome: "e2e_stub" })
    .where(sql`${dialerCampaignLeads.campaign_id} = ${campaignId} AND ${dialerCampaignLeads.status} = 'calling'`);
}

async function main() {
  await db.insert(dealerLeads).values(
    leadIds.map((id, i) => ({
      id,
      dealer_name: `E2E T10 test ${i}`,
      shop_name: `E2E T10 test ${i}`,
      phone: `+9190000${String(Date.now()).slice(-3)}${String(i).padStart(2, "0")}`,
      city: "Testpur",
      state: "Test",
    })),
  );
  const created = await createCampaign({
    queueIds: leadIds,
    provider: "elevenlabs",
    status: "running",
    name: `E2E task 10 carrier pause ${tag}`,
    maxRetries: 5,
  });
  campaignId = created.campaignId;
  if (!campaignId) throw new Error("createCampaign returned no id");
  console.log(`campaign ${campaignId}, ${created.queued} queued\n`);

  // ── 1. ten SIP 503 refusals pause it ──
  console.log("1. first pause");
  const r1 = await advanceCampaign(campaignId);
  let s = await state();
  check("advance returned carrier-paused", r1.kind === "carrier-paused", r1.kind);
  check("campaign paused, no resume_after", s.c.status === "paused" && s.c.resume_after === null, s.c.status);
  check("10 outbound attempts, none placed", outboundCalls === 10, String(outboundCalls));
  check("line health: reason carrier_refused, kind carrier, SIP 503", s.lh?.pause_reason === "carrier_refused" && s.lh?.block_kind === "carrier" && s.lh?.sip_code === 503, JSON.stringify(s.lh));
  check("refused rows back in the queue: 12 pending, none with a booked retry", s.rows.every((r) => r.status === "pending" && r.next_attempt_at === null), s.rows.map((r) => r.status).join(","));
  check("every attempt refunded (attempt_count 0)", s.rows.every((r) => r.attempt_count === 0), s.rows.map((r) => r.attempt_count).join(","));
  check("refunded_rows 10, cursor at queue position 0", s.lh?.refunded_rows === 10 && s.lh?.cursor_queue_position === 0, `${s.lh?.refunded_rows} / ${s.lh?.cursor_queue_position}`);
  check("first pause today: probe booked, no person needed", s.lh?.pauses_today === 1 && !s.lh?.needs_manual_resume && s.lh?.next_probe_at != null, JSON.stringify({ p: s.lh?.pauses_today, m: s.lh?.needs_manual_resume, n: s.lh?.next_probe_at }));
  check("v3: 10 dispositions, rule 4 / SIP 503", s.disp.length === 10 && s.disp.every((d) => d.rule_no === "4" && d.sip_code === 503), JSON.stringify(s.disp.slice(0, 2)));
  check("no touchpoints for our-side refusals", s.tps === 0, String(s.tps));
  check("exactly one alert", s.alerts === 1, String(s.alerts));

  // ── 2. a refused probe books the next ──
  console.log("2. refused probe");
  const due = new Date(new Date(s.lh!.next_probe_at).getTime() + 1000);
  const p1 = await runCarrierProbes(due, async () => ({ placed: false, detail: "sip status: 503" }));
  s = await state();
  check("probe ran and the campaign stays paused", p1.probed === 1 && s.c.status === "paused", JSON.stringify(p1));
  check("probe_count 1, next probe booked, not manual", s.lh?.probe_count === 1 && s.lh?.next_probe_at != null && !s.lh?.needs_manual_resume, JSON.stringify({ c: s.lh?.probe_count, n: s.lh?.next_probe_at }));
  const p1b = await runCarrierProbes(due, async () => ({ placed: true, detail: "x" }));
  check("a probe is not run before its time", p1b.probed === 0, JSON.stringify(p1b));

  // ── 3. a placed probe resumes from the cursor ──
  console.log("3. placed probe resumes");
  mode = "accept";
  const due2 = new Date(new Date(s.lh!.next_probe_at).getTime() + 1000);
  const p2 = await runCarrierProbes(due2, async () => ({ placed: true, detail: "conv_probe" }));
  await freeze();
  s = await state();
  const calledFirst = s.rows.find((r) => r.status === "completed" && r.call_outcome === "e2e_stub");
  check("probe resumed the campaign", p2.resumed.includes(campaignId), JSON.stringify(p2));
  check("the resumed dial really reached the provider (no duplicate-key suppression)", outboundCalls === 11, String(outboundCalls));
  check("the first lead dialled after resume is the cursor (queue position 0)", calledFirst?.queue_position === 0, String(calledFirst?.queue_position));
  check("pause cleared on resume, but the day's count kept", s.lh?.pause_reason === null && s.lh?.pauses_today === 1, JSON.stringify({ r: s.lh?.pause_reason, p: s.lh?.pauses_today }));

  // ── 4. the second pause the same day waits for a person ──
  console.log("4. second pause the same day");
  mode = "refuse";
  await db.update(dialerCampaigns).set({ status: "running" }).where(eq(dialerCampaigns.id, campaignId));
  const r4 = await advanceCampaign(campaignId);
  s = await state();
  check("paused again", r4.kind === "carrier-paused" && s.c.status === "paused", r4.kind);
  check("pauses_today 2 → manual, no probe booked", s.lh?.pauses_today === 2 && s.lh?.needs_manual_resume === true && s.lh?.next_probe_at === null, JSON.stringify({ p: s.lh?.pauses_today, m: s.lh?.needs_manual_resume, n: s.lh?.next_probe_at }));
  check("a second alert (one per pause)", s.alerts === 2, String(s.alerts));
  const p4 = await runCarrierProbes(new Date(Date.now() + 3 * 3600_000), async () => ({ placed: true, detail: "x" }));
  check("the tick never probes a manual pause", p4.probed === 0, JSON.stringify(p4));

  // ── 5. manual Resume runs the probe first ──
  console.log("5. manual resume");
  const m1 = await resumeAfterProbe(campaignId, async () => ({ placed: false, detail: "sip status: 403" }));
  s = await state();
  check("refused probe → resume refused, still paused", !m1.ok && s.c.status === "paused", JSON.stringify(m1));
  const m2 = await resumeAfterProbe(campaignId, async () => ({ placed: true, detail: "conv" }));
  check("placed probe → resume allowed", m2.ok === true, JSON.stringify(m2));

  // ── 6. six refused probes stop the automatic probing ──
  console.log("6. probe cap");
  await db.execute(sql`
    UPDATE dialer_campaign_line_health
       SET needs_manual_resume = false, probe_count = 5, next_probe_at = now() - interval '1 minute'
     WHERE campaign_id = ${campaignId}`);
  const p6 = await runCarrierProbes(new Date(), async () => ({ placed: false, detail: "sip status: 503" }));
  s = await state();
  check("the 6th refused probe → manual, no next probe", p6.probed === 1 && s.lh?.probe_count === 6 && s.lh?.needs_manual_resume === true && s.lh?.next_probe_at === null, JSON.stringify({ c: s.lh?.probe_count, m: s.lh?.needs_manual_resume }));

  await clearCarrierPause(campaignId);
}

async function cleanup() {
  if (campaignId) {
    await db.update(dialerCampaigns).set({ status: "cancelled" }).where(eq(dialerCampaigns.id, campaignId));
    await db.execute(sql`DELETE FROM notifications WHERE type = 'dialer.campaign_paused' AND data->>'campaignId' = ${campaignId}`);
    await db.execute(sql`DELETE FROM dialer_campaign_line_health WHERE campaign_id = ${campaignId}`);
    await db.execute(sql`DELETE FROM ai_dial_dispositions WHERE campaign_id = ${campaignId}`);
    await db.delete(dialerCampaignLeads).where(eq(dialerCampaignLeads.campaign_id, campaignId));
    await db.delete(dialerCampaigns).where(eq(dialerCampaigns.id, campaignId));
  }
  await db.execute(sql`DELETE FROM dialer_number_stats WHERE lead_id LIKE ${tag + "%"}`);
  await db.execute(sql`DELETE FROM lead_touchpoints WHERE dealer_lead_id LIKE ${tag + "%"}`);
  await db.execute(sql`DELETE FROM dealer_lead_phone_type WHERE lead_id LIKE ${tag + "%"}`).catch(() => {});
  await db.execute(sql`DELETE FROM ai_call_logs WHERE lead_id LIKE ${tag + "%"}`).catch(() => {});
  await db.delete(dealerLeads).where(inArray(dealerLeads.id, leadIds));
  console.log("\ncleaned up test campaign, leads, dispositions, alerts");
}

main()
  .catch((e) => {
    failed++;
    console.error("threw:", e);
  })
  .finally(async () => {
    await cleanup().catch((e) => console.error("cleanup failed:", e));
    console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILURE(S)`}`);
    process.exit(failed === 0 ? 0 : 1);
  });
