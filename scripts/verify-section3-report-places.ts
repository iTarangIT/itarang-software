// Read-only check of the Aditya tab, section 3 (27 Oct sheet): the report
// places that must show the same number as their item.
//
//   node --import tsx --env-file=.env.local      scripts/verify-section3-report-places.ts
//   node --import tsx --env-file=.env.production scripts/verify-section3-report-places.ts
//
// Rows 29-44 (ID 167)  the Analyst's analyst_ro login: users, raw leads and
//                      ecofy_leads blocked; a sample of withheld columns unreadable.
// Row 45 (ID 184)      the ready-leads card: Hot first, parts add up to the total.
// Row 46 (ID 148)      the Analyst's live dealers and GSTIN missing = Account management's.
// Row 47 (ID 185)      Targets 'Dealer visits' stays distinct dealers (decided 29 Oct).
// Rows 48-50 (A16)     the item-family back-fill has nothing left to write.
// Row 51 (A31)         the Leads export's Campaign = the list's (fetchCampaignForLeads).
//
// The full ID 184 cross-check (CEO card, list, daily email) is
// scripts/verify-id184-ready-no-owner.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { countAccounts } from "@/lib/accounts/accountList";
import { countAwaitingAssignment } from "@/lib/leads/salesReady";
import { salesHeadActionSummary } from "@/lib/dashboard/salesHeadActions";
import { reapplyFamilyMappings } from "@/lib/sales/vyaparImport";

const ROLE = "analyst_ro";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

type R = Record<string, unknown>;
const one = async (q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as R[])[0] ?? {};

// A sample of scripts/_create-analyst-readonly-role.mjs SAMPLE_WITHHELD, one
// per sheet row 29-42; pairs not in this database are skipped.
const WITHHELD: Array<[string, string]> = [
    ["dealer_leads", "dealer_name"],
    ["dealer_leads", "memory"],
    ["lead_touchpoints", "external_agent_name"],
    ["lead_escalations", "ceo_recommendation"],
    ["lead_flow_events", "actor_label"],
    ["ai_call_logs", "intent_reason"],
    ["dialer_campaign_leads", "attempt_history"],
    ["ecofy_lead_activities", "created_by_name"],
    ["scraped_dealer_leads", "source_url"],
    ["deployed_assets", "deployment_location"],
    ["expense_submissions", "vendor"],
    ["sales_invoices", "storage_key"],
    ["orders", "transaction_id"],
    ["accounts", "gstin"],
];

async function columnExists(t: string, c: string): Promise<boolean> {
    const r = await one(sql`SELECT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${t} AND column_name = ${c}) AS ok`);
    return r.ok === true;
}

async function analystChecks() {
    const role = await one(sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}) AS ok`);
    check(`rows 29-44: the ${ROLE} login exists`, role.ok === true);
    if (role.ok !== true) return;

    const blocked = await one(sql`SELECT
        NOT has_table_privilege(${ROLE}, 'public.users', 'SELECT') AS users,
        (to_regclass('public.leads') IS NULL OR NOT has_table_privilege(${ROLE}, 'public.leads', 'SELECT')) AS leads,
        (to_regclass('public.ecofy_leads') IS NULL OR NOT has_table_privilege(${ROLE}, 'public.ecofy_leads', 'SELECT')) AS ecofy`);
    check("rows 29, 36: users, raw leads and ecofy_leads are not readable", blocked.users === true && blocked.leads === true && blocked.ecofy === true, blocked);

    const leaked: string[] = [];
    let checked = 0;
    for (const [t, c] of WITHHELD) {
        if (!(await columnExists(t, c))) continue;
        checked++;
        const r = await one(sql`SELECT has_column_privilege(${ROLE}, ${"public." + t}, ${c}, 'SELECT') AS ok`);
        if (r.ok === true) leaked.push(`${t}.${c}`);
    }
    check(`rows 29-42: ${checked} sampled withheld columns are unreadable`, checked > 0 && leaked.length === 0, leaked.length ? leaked : undefined);

    // Row 46 (ID 148): the tables the rule names are granted, the GSTIN is not.
    const grants = await one(sql`SELECT
        -- Column grants (account_closures.reason is withheld), so per column.
        (has_column_privilege(${ROLE}, 'public.account_closures', 'account_id', 'SELECT')
         AND has_column_privilege(${ROLE}, 'public.account_closures', 'closed_at', 'SELECT')) AS closures,
        (to_regclass('public.analyst_account_flags') IS NOT NULL
         AND has_table_privilege(${ROLE}, 'public.analyst_account_flags', 'SELECT')) AS flags`);
    check("row 46: account_closures (account_id, closed_at) and analyst_account_flags are readable", grants.closures === true && grants.flags === true, grants);
    if (grants.flags !== true) return;

    // The Analyst rule (metricDefinitions.ts, ID 148): live dealers = is_dealer and no
    // account_closures row; GSTIN missing = gstin_missing. Same as Account management.
    const analyst = await one(sql`SELECT
        COUNT(*) FILTER (WHERE f.is_dealer AND NOT EXISTS (SELECT 1 FROM account_closures c WHERE c.account_id = f.account_id))::int AS live,
        COUNT(*) FILTER (WHERE f.is_dealer AND f.gstin_missing
                           AND NOT EXISTS (SELECT 1 FROM account_closures c WHERE c.account_id = f.account_id))::int AS gstin_missing
        FROM analyst_account_flags f`);
    const crm = await countAccounts();
    check(`row 46: Analyst live dealers (${analyst.live}) = Account management (${crm.total})`, analyst.live === crm.total);
    check(`row 46: Analyst GSTIN missing (${analyst.gstin_missing}) = Account management (${crm.gstin_missing})`, analyst.gstin_missing === crm.gstin_missing);
}

async function readyCard() {
    const c = await countAwaitingAssignment();
    const tile = (await salesHeadActionSummary({ viewerRole: "admin" })).sales_ready;
    check(`row 45: card (${tile?.count}) = rule (${c.total}), parts add up`, tile?.count === c.total && c.split.hot + c.split.ai + c.split.other === c.total, c.split);
    const want = `Hot ${c.split.hot} · AI-qualified ${c.split.ai} · Other ${c.split.other}`;
    check("row 45: the card line reads Hot first", (tile?.sub ?? "").startsWith(want), tile?.sub);
}

function sourceChecks() {
    const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
    const targets = src("src/lib/targets/service.ts");
    check(
        "row 47: Targets 'Dealer visits' counts distinct dealers visited",
        /case "dealer_visits":[\s\S]{0,400}?unique_visits/.test(targets),
    );
    const exp = src("src/app/api/dealer-leads/export/route.ts");
    const list = src("src/app/api/dealer-leads/route.ts");
    check(
        "row 51: the Leads export and the list both take the campaign from fetchCampaignForLeads",
        /fetchCampaignForLeads\(/.test(exp) && /fetchCampaignForLeads\(/.test(list) && /header: "Campaign System"/.test(exp),
    );
}

async function main() {
    await db.execute(sql`SET default_transaction_read_only = on`);
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}\n`);

    await analystChecks();
    await readyCard();
    sourceChecks();

    // Rows 48-50 (A16): a dry run of the back-fill stamps no line, so Item
    // mapping, Gross margin and By SKU agree. A family row still to write with
    // no line behind it changes no number today; it is listed, not failed.
    const fam = await reapplyFamilyMappings({ apply: false });
    check(`rows 48-50: item-family back-fill has no line left to stamp (${fam.lines_stamped})`, fam.lines_stamped === 0);
    if (fam.families_written.length) {
        console.log(`WARN  rows 48-50: ${fam.families_written.length} family key(s) still to write, no lines behind them: ` +
            fam.families_written.map((f) => f.family_key).join(", ") + " (scripts/backfill-item-families.ts --apply)");
    }

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
