// E-315 — prove the campaign auto-retry loop against a real database, without
// placing a single call.
//
//   node --import tsx --env-file=.env.local scripts/verify-e315-campaign-retry.ts
//
// Builds a throwaway campaign (id prefix camp_verify_e315_) whose lead ids do
// not exist, drives it through the REAL recordAttemptOutcome /
// completeCampaignLead / advanceCampaign / sweep code, asserts, and deletes it
// again. Nothing here can dial: every advanceCampaign call is made while the
// only rows are either booked in the future or already terminal, so the claim
// finds nothing and no lead is loaded or triggered.
//
// Sandbox only: refuses database-2 (prod), where it would write rows.

import { db } from "@/lib/db";
import { dialerCampaigns, dialerCampaignLeads } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  completeCampaignLead,
  recordAttemptOutcome,
} from "@/lib/queue/campaignTracker";
import { advanceCampaign } from "@/lib/queue/advanceCampaign";

const url = process.env.DATABASE_URL ?? "";
if (/database-2/.test(url)) {
  console.error("Refusing to run against database-2 (prod) — this script writes rows.");
  process.exit(1);
}

const CID = `camp_verify_e315_${Date.now().toString(36)}`;
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`, ok ? "" : (detail ?? ""));
  if (!ok) failures++;
}

async function row(id: string) {
  const r = await db.select().from(dialerCampaignLeads).where(eq(dialerCampaignLeads.id, id));
  return r[0];
}

async function main() {
  await db.insert(dialerCampaigns).values({
    id: CID,
    name: "E-315 verify (throwaway)",
    provider: "elevenlabs",
    status: "stopped", // nothing may dial while we set up
    total_leads: 3,
    max_retries: 3,
    schedule_mode: "now",
  });
  // A: in flight, first dial. B: already completed. C: in flight on its LAST dial.
  await db.insert(dialerCampaignLeads).values([
    { id: `${CID}_a`, campaign_id: CID, lead_id: `${CID}_lead_a`, queue_position: 0, status: "calling", attempt_count: 1, bolna_call_id: "conv_a1" },
    { id: `${CID}_b`, campaign_id: CID, lead_id: `${CID}_lead_b`, queue_position: 1, status: "completed", attempt_count: 1 },
    { id: `${CID}_c`, campaign_id: CID, lead_id: `${CID}_lead_c`, queue_position: 2, status: "calling", attempt_count: 4, bolna_call_id: "conv_c4" },
  ]);

  // 1. busy on the first dial → a retry is booked, status keeps 'busy'.
  const r1 = await recordAttemptOutcome({ campaignLeadId: `${CID}_a`, status: "busy", outcome: "busy", bolnaCallId: "conv_a1" });
  const a1 = await row(`${CID}_a`);
  check("busy first dial books a retry", r1.written && r1.retryAt != null && a1.next_attempt_at != null, r1);
  check("status keeps the outcome while a retry is booked", a1.status === "busy", a1.status);
  check("attempt_history records the attempt", Array.isArray(a1.attempt_history) && (a1.attempt_history as unknown[]).length === 1, a1.attempt_history);

  // 2. a second writer for the same attempt is a no-op.
  const r2 = await recordAttemptOutcome({ campaignLeadId: `${CID}_a`, status: "failed", outcome: "no_webhook" });
  check("duplicate outcome for a finished attempt is ignored", !r2.written && (await row(`${CID}_a`)).status === "busy");

  // 3. a stale webhook (earlier call id) cannot close the in-flight retry.
  await db.update(dialerCampaignLeads)
    .set({ status: "calling", attempt_count: 2, next_attempt_at: null, bolna_call_id: "conv_a2" })
    .where(eq(dialerCampaignLeads.id, `${CID}_a`));
  const stale = await completeCampaignLead({ leadId: `${CID}_lead_a`, campaignId: CID, status: "no_response", bolnaCallId: "conv_a1" });
  check("stale webhook for an earlier attempt is ignored", stale.campaignId === null && (await row(`${CID}_a`)).status === "calling");
  const fresh = await completeCampaignLead({ leadId: `${CID}_lead_a`, campaignId: CID, status: "no_response", bolnaCallId: "conv_a2" });
  const a3 = await row(`${CID}_a`);
  check("webhook for the current attempt is recorded + rebooked", fresh.campaignId === CID && a3.status === "no_response" && a3.next_attempt_at != null, a3);

  // 4. the last allowed dial books nothing.
  const r4 = await recordAttemptOutcome({ campaignLeadId: `${CID}_c`, status: "busy", outcome: "busy", bolnaCallId: "conv_c4" });
  check("4th dial (1 + max_retries) books no retry", r4.written && r4.retryAt === null && (await row(`${CID}_c`)).next_attempt_at === null, r4);

  // 5. running campaign, only a FUTURE retry left → waiting, not completed.
  await db.update(dialerCampaignLeads)
    .set({ next_attempt_at: sql`now() + interval '2 hours'` })
    .where(eq(dialerCampaignLeads.id, `${CID}_a`));
  await db.update(dialerCampaigns).set({ status: "running" }).where(eq(dialerCampaigns.id, CID));
  const adv = await advanceCampaign(CID);
  const camp = (await db.select().from(dialerCampaigns).where(eq(dialerCampaigns.id, CID)))[0];
  check("campaign with a booked retry is NOT finalized", adv.kind === "waiting-retry" && camp.status === "running", { adv, status: camp.status });

  // 6. retries exhausted → advance finalizes 'completed'.
  await db.update(dialerCampaignLeads).set({ next_attempt_at: null }).where(eq(dialerCampaignLeads.id, `${CID}_a`));
  const adv2 = await advanceCampaign(CID);
  const camp2 = (await db.select().from(dialerCampaigns).where(eq(dialerCampaigns.id, CID)))[0];
  check("campaign with no retries left completes", adv2.kind === "no-pending" && camp2.status === "completed", { adv2, status: camp2.status });
}

(async () => {
  try {
    await main();
  } catch (err) {
    failures++;
    console.error("ERROR", err);
  } finally {
    await db.delete(dialerCampaignLeads).where(eq(dialerCampaignLeads.campaign_id, CID));
    await db.delete(dialerCampaigns).where(eq(dialerCampaigns.id, CID));
    console.log(`cleaned up ${CID}`);
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  }
})();
