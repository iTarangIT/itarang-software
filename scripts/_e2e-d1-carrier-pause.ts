// One-off end-to-end test of D1 (carrier-refusal auto-pause) against SANDBOX.
//
//   ELEVENLABS_API_KEY=bogus-e2e-key AGENTMAIL_API_KEY= SMTP_HOST= \
//     node --import tsx --env-file=.env.local scripts/_e2e-d1-carrier-pause.ts
//
// A wrong ElevenLabs key makes every trigger fail on auth ("Invalid API key" →
// config_error → line-blocked), so no phone can ring. Creates 12 throwaway
// leads + a campaign, runs the real advanceCampaign, asserts, resumes once,
// then deletes everything it created.
import { sql, inArray, eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { dealerLeads, dialerCampaigns, dialerCampaignLeads, notifications } from "../src/lib/db/schema";
import { createCampaign } from "../src/lib/queue/campaignTracker";
import { advanceCampaign } from "../src/lib/queue/advanceCampaign";
import { resumeDueCampaigns, wakeDueRetries } from "../src/lib/queue/resumeCampaigns";
import { clearCarrierPause } from "../src/lib/ai-dialer/lineHealth";

if (process.env.ELEVENLABS_API_KEY !== "bogus-e2e-key") throw new Error("refusing: real ElevenLabs key in env");
if (process.env.AGENTMAIL_API_KEY || process.env.SMTP_HOST) throw new Error("refusing: email is configured");
const host = new URL(process.env.DATABASE_URL!).host;
if (!host.startsWith("database-1.")) throw new Error(`refusing: not sandbox (${host.split(".")[0]})`);

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${detail}`}`);
};

const tag = `e2ed1${Date.now().toString(36)}`;
const leadIds = Array.from({ length: 12 }, (_, i) => `${tag}_${i}`);
let campaignId: string | null = null;

async function state() {
  const [c] = await db.select().from(dialerCampaigns).where(eq(dialerCampaigns.id, campaignId!));
  const rows = await db.select().from(dialerCampaignLeads).where(eq(dialerCampaignLeads.campaign_id, campaignId!));
  const [lh] = (await db.execute(sql`SELECT * FROM dialer_campaign_line_health WHERE campaign_id = ${campaignId}`)) as any[];
  const alerts = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(sql`${notifications.type} = 'dialer.campaign_paused' AND ${notifications.data}->>'href' LIKE ${"%" + campaignId}`);
  const dialled = rows.filter((r) => (r.attempt_history as unknown[]).length > 0);
  return { c, rows, lh, alerts, dialled };
}

async function main() {
  const live = (await db.execute(sql`
    SELECT (SELECT count(*) FROM dialer_campaign_leads WHERE status = 'calling')::int AS calling,
           (SELECT count(*) FROM dialer_campaigns WHERE status = 'running')::int AS running`)) as any[];
  console.log(`sandbox before: ${live[0].calling} calling rows, ${live[0].running} running campaigns`);

  await db.insert(dealerLeads).values(
    leadIds.map((id, i) => ({
      id,
      dealer_name: `E2E D1 test ${i}`,
      shop_name: `E2E D1 test ${i}`,
      phone: `600000${String(Date.now()).slice(-2)}${String(i).padStart(2, "0")}`,
      city: "Testpur",
      state: "Test",
    })),
  );
  const created = await createCampaign({
    queueIds: leadIds,
    provider: "elevenlabs",
    status: "running",
    name: `E2E D1 carrier pause ${tag}`,
    maxRetries: 3,
  });
  campaignId = created.campaignId;
  if (!campaignId) throw new Error("createCampaign returned no id");
  console.log(`campaign ${campaignId}, ${created.queued} queued\n`);

  const t0 = Date.now();
  const r1 = await advanceCampaign(campaignId);
  console.log(`advance #1 → ${JSON.stringify(r1)} in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  let s = await state();
  check("advance returned carrier-paused", r1.kind === "carrier-paused", r1.kind);
  check("exactly 10 dials", s.dialled.length === 10, `${s.dialled.length}`);
  check("2 leads never dialled", s.rows.filter((r) => (r.attempt_history as unknown[]).length === 0).length === 2);
  check("campaign status paused", s.c.status === "paused", s.c.status);
  check("resume_after is NULL (no auto-resume)", s.c.resume_after === null, String(s.c.resume_after));
  check("line health: count 10, reason carrier_refused", s.lh?.consecutive_line_blocked === 10 && s.lh?.pause_reason === "carrier_refused", JSON.stringify(s.lh));
  check("last carrier error recorded", /api key/i.test(s.lh?.last_carrier_error ?? ""), s.lh?.last_carrier_error);
  check("every attempt refunded (attempt_count 0)", s.rows.every((r) => r.attempt_count === 0), s.rows.map((r) => r.attempt_count).join(","));
  check("dials ≥ 2s apart (18s+ for 10)", Date.now() - t0 >= 18_000, `${Date.now() - t0}ms`);
  check("at least one bell alert", s.alerts.length >= 1, `${s.alerts.length}`);
  const alertsAfterFirst = s.alerts.length;

  const r2 = await advanceCampaign(campaignId);
  check("advance on a paused campaign dials nothing", r2.kind === "campaign-not-running" && (await state()).dialled.length === 10, r2.kind);

  await resumeDueCampaigns();
  await wakeDueRetries();
  s = await state();
  check("window tick does not resume it", s.c.status === "paused", s.c.status);
  check("no extra alert from the tick", s.alerts.length === alertsAfterFirst, `${s.alerts.length}`);

  // Resume (what the Resume route does before startDraftCampaign).
  await clearCarrierPause(campaignId);
  s = await state();
  check("Resume clears the count and reason", s.lh?.consecutive_line_blocked === 0 && s.lh?.pause_reason === null, JSON.stringify(s.lh));
  await db.update(dialerCampaigns).set({ status: "running" }).where(eq(dialerCampaigns.id, campaignId));
  const r3 = await advanceCampaign(campaignId);
  s = await state();
  // Two fresh leads plus refunded rows whose retry isn't due yet: it dials the
  // 2 pending leads, then goes idle waiting on the booked retries.
  console.log(`advance after resume → ${JSON.stringify(r3)}`);
  check("after Resume it dials again from a zero count", s.dialled.length === 12 && s.lh?.consecutive_line_blocked === 2, `dialled ${s.dialled.length}, count ${s.lh?.consecutive_line_blocked}`);
}

async function cleanup() {
  if (campaignId) {
    await db.update(dialerCampaigns).set({ status: "cancelled" }).where(eq(dialerCampaigns.id, campaignId));
    await db.delete(notifications).where(sql`${notifications.type} = 'dialer.campaign_paused' AND ${notifications.data}->>'href' LIKE ${"%" + campaignId}`);
    await db.execute(sql`DELETE FROM dialer_campaign_line_health WHERE campaign_id = ${campaignId}`);
    await db.delete(dialerCampaignLeads).where(eq(dialerCampaignLeads.campaign_id, campaignId));
    await db.delete(dialerCampaigns).where(eq(dialerCampaigns.id, campaignId));
  }
  await db.execute(sql`DELETE FROM ai_call_logs WHERE lead_id LIKE ${tag + "%"}`).catch(() => {});
  await db.delete(dealerLeads).where(inArray(dealerLeads.id, leadIds));
  console.log("\ncleaned up test campaign, leads, alerts");
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
