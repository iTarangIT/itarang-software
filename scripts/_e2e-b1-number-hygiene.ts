// One-off end-to-end check of B1 + D7 against SANDBOX: mobiles only, no vehicle
// showrooms, one dial per number, and the /leads "Needs dealer mobile" filter.
//
//   node --import tsx --env-file=.env.local scripts/_e2e-b1-number-hygiene.ts
//
// Creates throwaway leads and a DRAFT campaign (a draft never dials), checks
// what was enrolled and why, runs the real /leads filter, then deletes it all.
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { dealerLeads, dialerCampaigns, dialerCampaignLeads } from "../src/lib/db/schema";
import { createCampaign } from "../src/lib/queue/campaignTracker";
import { parseLeadListFilters } from "../src/lib/leads/leadListParams";
import { fetchLeadListIds } from "../src/lib/leads/leadListQuery";
import { capabilitiesFor } from "../src/lib/leads/access";
import { deriveFailureReason } from "../src/lib/ai-dialer/failureReason";

const host = new URL(process.env.DATABASE_URL!).host;
if (!host.startsWith("database-1.")) throw new Error(`refusing: not sandbox (${host.split(".")[0]})`);

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${detail}`}`);
};

const tag = `e2eb1${Date.now().toString(36)}`;
const n = (s: string) => `${tag}_${s}`;
const uniq = String(Date.now()).slice(-4);
const LEADS = [
    { id: n("good"), phone: `+9170000${uniq}1`, shop_name: "Shree Batteries" },
    { id: n("dup"), phone: `70000${uniq}1`, shop_name: "Shree Batteries (branch)" }, // same number, other shape
    { id: n("landline"), phone: `+91 80 6${uniq}123`, shop_name: "Exide Care - Need Battery House" },
    { id: n("showroom"), phone: `+9170000${uniq}2`, shop_name: "TVS - Kunal Automobile" },
    { id: n("motors"), phone: `+9170000${uniq}3`, shop_name: "Terra Motors Bhopal" },
];
let campaignId: string | null = null;

async function main() {
    // dealer_leads.phone is UNIQUE, so the duplicate is stored in a different
    // shape — exactly how repeats slip in from different sources.
    await db.insert(dealerLeads).values(LEADS.map((l) => ({ ...l, dealer_name: l.shop_name, city: "Testpur" })));

    const r = await createCampaign({
        queueIds: LEADS.map((l) => l.id),
        provider: "elevenlabs",
        status: "draft",
        name: `E2E B1 number hygiene ${tag}`,
    });
    campaignId = r.campaignId;
    console.log("createCampaign →", JSON.stringify({ ...r, campaignId: !!r.campaignId }));
    check("campaign created", !!campaignId);
    check("2 dialable leads queued (good + Motors)", r.queued === 2 && r.dialIds.join() === [n("good"), n("motors")].join(), r.dialIds.join());
    check(
        "skip counts",
        r.skippedAtEnrol.duplicate_number === 1 && r.skippedAtEnrol.not_mobile === 1 && r.skippedAtEnrol.vehicle_showroom === 1,
        JSON.stringify(r.skippedAtEnrol),
    );

    const [c] = await db.select().from(dialerCampaigns).where(eq(dialerCampaigns.id, campaignId!));
    check("total_leads counts only dialable leads", c.total_leads === 2, String(c.total_leads));

    const rows = await db.select().from(dialerCampaignLeads).where(eq(dialerCampaignLeads.campaign_id, campaignId!));
    const by = new Map(rows.map((x) => [x.lead_id, x]));
    const label = (id: string) => {
        const row = by.get(id)!;
        return deriveFailureReason({ status: row.status, callOutcome: row.call_outcome })?.label;
    };
    check("all 5 leads listed in the campaign", rows.length === 5, String(rows.length));
    check("duplicate shows 'Skipped, duplicate number'", by.get(n("dup"))?.status === "skipped" && label(n("dup")) === "Skipped, duplicate number", `${by.get(n("dup"))?.call_outcome} / ${label(n("dup"))}`);
    check("landline shows 'Skipped, not a mobile'", label(n("landline")) === "Skipped, not a mobile", String(label(n("landline"))));
    check("showroom shows 'Skipped, vehicle showroom'", label(n("showroom")) === "Skipped, vehicle showroom", String(label(n("showroom"))));
    check("dialable rows are pending", by.get(n("good"))?.status === "pending" && by.get(n("motors"))?.status === "pending");

    const types = (await db.execute(sql`
        SELECT lead_id, phone_type FROM dealer_lead_phone_type WHERE lead_id LIKE ${tag + "%"}`)) as unknown as { lead_id: string; phone_type: string }[];
    const t = new Map(types.map((x) => [x.lead_id, x.phone_type]));
    check("phone types recorded", t.get(n("landline")) === "fixed_line" && t.get(n("good")) === "mobile", JSON.stringify(Object.fromEntries(t)));

    const filters = await parseLeadListFilters(
        new URLSearchParams({ needs_mobile: "1", search: tag, hide_dead: "0" }),
        capabilitiesFor("admin"),
    );
    const ids = await fetchLeadListIds({ ...filters, search: null });
    const mine = ids.filter((id) => id.startsWith(tag));
    check("/leads 'Needs dealer mobile' lists the landline only", mine.join() === n("landline"), mine.join());

    // A changed number makes the stored type stale: the lead drops out of the filter.
    await db.update(dealerLeads).set({ phone: `+9170000${uniq}4` }).where(eq(dealerLeads.id, n("landline")));
    const after = (await fetchLeadListIds({ ...filters, search: null })).filter((id) => id.startsWith(tag));
    check("a lead whose number changed drops out", after.length === 0, after.join());
}

async function cleanup() {
    if (campaignId) {
        await db.delete(dialerCampaignLeads).where(eq(dialerCampaignLeads.campaign_id, campaignId));
        await db.delete(dialerCampaigns).where(eq(dialerCampaigns.id, campaignId));
    }
    // dealer_lead_phone_type rows go with the leads (ON DELETE CASCADE).
    await db.delete(dealerLeads).where(inArray(dealerLeads.id, LEADS.map((l) => l.id)));
    const left = (await db.execute(sql`SELECT count(*)::int AS n FROM dealer_lead_phone_type WHERE lead_id LIKE ${tag + "%"}`)) as unknown as { n: number }[];
    console.log(`\ncleaned up (phone-type rows left: ${left[0].n})`);
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
