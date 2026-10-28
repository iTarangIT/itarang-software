// One-off end-to-end check of D2 / D7 against SANDBOX: a call answered by a
// switchboard is filed Switchboard, not redialled, the number is marked, the
// next campaign skips it (even under another lead), and a later call that
// reaches a person clears the mark.
//
//   node --import tsx --env-file=.env.local scripts/_e2e-d2-switchboard.ts
//
// Uses DRAFT campaigns (a draft never dials) and feeds call results through
// completeCampaignLead — the function both finalizers call. Cleans up.
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { dealerLeads, dialerCampaigns, dialerCampaignLeads } from "../src/lib/db/schema";
import { completeCampaignLead, createCampaign } from "../src/lib/queue/campaignTracker";
import { classifyCallEnd } from "../src/lib/ai-dialer/campaignLeadStatus";

const host = new URL(process.env.DATABASE_URL!).host;
if (!host.startsWith("database-1.")) throw new Error(`refusing: not sandbox (${host.split(".")[0]})`);

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${detail}`}`);
};

const tag = `e2ed2${Date.now().toString(36)}`;
const uniq = String(Date.now()).slice(-5);
const IVR = `+91900${uniq}11`;
const LEADS = [
    { id: `${tag}_ivr`, phone: IVR, shop_name: "Tata Motors Patna" },
    { id: `${tag}_ivr2`, phone: IVR.replace("+91", ""), shop_name: "Same switchboard, other listing" },
    { id: `${tag}_vm`, phone: `+91900${uniq}22`, shop_name: "Personal voicemail" },
];
const campaigns: string[] = [];

const typeOf = async (leadId: string) =>
    ((await db.execute(sql`SELECT phone_type FROM dealer_lead_phone_type WHERE lead_id = ${leadId}`)) as unknown as {
        phone_type: string;
    }[])[0]?.phone_type ?? null;

async function main() {
    await db.insert(dealerLeads).values(LEADS.map((l) => ({ ...l, dealer_name: l.shop_name, city: "Testpur" })));

    const c1 = await createCampaign({
        queueIds: [LEADS[0].id, LEADS[2].id],
        provider: "elevenlabs",
        status: "draft",
        name: `E2E D2 ${tag}`,
        maxRetries: 3,
    });
    campaigns.push(c1.campaignId!);

    // What the finalizer decides for an IVR menu flagged as voicemail, and for
    // a personal voicemail greeting.
    const ivr = classifyCallEnd({
        transcript: "agent: Namaste ji\nuser: Welcome to Tata Motors. For sales, press 1. For service, press 2.",
        terminationReason: "Voicemail detected",
    });
    const vm = classifyCallEnd({
        transcript: "agent: Namaste ji\nuser: The person you are calling is not available. Please leave your message after the beep.",
        terminationReason: "Voicemail detected",
    });
    check("IVR flagged as voicemail is classified Switchboard", ivr.status === "switchboard", ivr.status);
    check("personal voicemail stays Voicemail", vm.status === "voicemail", vm.status);

    await completeCampaignLead({ leadId: LEADS[0].id, status: ivr.status, campaignId: c1.campaignId, outcome: "done" });
    await completeCampaignLead({ leadId: LEADS[2].id, status: vm.status, campaignId: c1.campaignId, outcome: "done" });

    const rows = await db.select().from(dialerCampaignLeads).where(eq(dialerCampaignLeads.campaign_id, c1.campaignId!));
    const by = new Map(rows.map((r) => [r.lead_id, r]));
    check("switchboard row: status switchboard, no retry booked", by.get(LEADS[0].id)?.status === "switchboard" && by.get(LEADS[0].id)?.next_attempt_at === null, JSON.stringify({ s: by.get(LEADS[0].id)?.status, n: by.get(LEADS[0].id)?.next_attempt_at }));
    check("voicemail row: retry booked", by.get(LEADS[2].id)?.status === "voicemail" && by.get(LEADS[2].id)?.next_attempt_at !== null);
    check("number marked switchboard", (await typeOf(LEADS[0].id)) === "switchboard", String(await typeOf(LEADS[0].id)));
    const [c] = await db.select().from(dialerCampaigns).where(eq(dialerCampaigns.id, c1.campaignId!));
    check("calls_made counts the switchboard attempt", c.calls_made === 2, String(c.calls_made));

    // A new campaign: the other listing on the same switchboard is skipped.
    const c2 = await createCampaign({ queueIds: [LEADS[1].id, LEADS[2].id], provider: "elevenlabs", status: "draft", name: `E2E D2b ${tag}` });
    campaigns.push(c2.campaignId!);
    const rows2 = await db.select().from(dialerCampaignLeads).where(eq(dialerCampaignLeads.campaign_id, c2.campaignId!));
    const r2 = rows2.find((r) => r.lead_id === LEADS[1].id);
    check("next campaign skips the switchboard number under another lead", r2?.status === "skipped" && r2?.call_outcome === "skipped_switchboard", `${r2?.status}/${r2?.call_outcome}`);
    check("skip counted", c2.skippedAtEnrol.switchboard === 1, JSON.stringify(c2.skippedAtEnrol));

    // A person answers on a later attempt: the mark clears.
    const c3 = await createCampaign({ queueIds: [LEADS[0].id], provider: "elevenlabs", status: "draft", name: `E2E D2c ${tag}` });
    // The lead itself is skipped too, so put a pending row in by hand to
    // stand for an attempt that was already queued.
    if (c3.campaignId) campaigns.push(c3.campaignId);
    await db.update(dialerCampaignLeads).set({ status: "pending", call_outcome: null }).where(eq(dialerCampaignLeads.lead_id, LEADS[0].id));
    await completeCampaignLead({ leadId: LEADS[0].id, status: "completed", campaignId: c1.campaignId, outcome: "done" });
    check("a person answering clears the mark", (await typeOf(LEADS[0].id)) === "mobile", String(await typeOf(LEADS[0].id)));
}

async function cleanup() {
    for (const id of campaigns.filter(Boolean)) {
        await db.delete(dialerCampaignLeads).where(eq(dialerCampaignLeads.campaign_id, id));
        await db.delete(dialerCampaigns).where(eq(dialerCampaigns.id, id));
    }
    await db.delete(dialerCampaignLeads).where(inArray(dialerCampaignLeads.lead_id, LEADS.map((l) => l.id)));
    await db.delete(dealerLeads).where(inArray(dealerLeads.id, LEADS.map((l) => l.id)));
    console.log("\ncleaned up");
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
