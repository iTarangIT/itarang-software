// The data download catalogue (tracker ID 13). Each dataset says who may
// download it, how it can be filtered, what its columns mean, and how to count
// and fetch its rows. All 13 agreed on 29 Sep 2026 are here, in the spec's order.
// SERVER ONLY: the builders query the database.

import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { listAccounts } from "@/lib/accounts/accountList";
import { hasAccountOwnershipTables } from "@/lib/accounts/tables";
import { countLeadsForExport, fetchLeadsForExport } from "@/lib/admin/leadsExport";
import { BUYBACK_ADMIN_ROLES } from "@/lib/buyback/roles";
import { matchedUnion, REVENUE_NOT_VOID, REVENUE_OUTSTANDING } from "@/lib/dashboard/revenueSource";
import { hasInvoiceLedgerTables } from "@/lib/sales/ledgerTables";
import { ACCOUNT_BUCKET_LABELS, ACCOUNT_BUCKETS, type AccountBucket } from "@/lib/dealers/accountHealthRules";
import { INVENTORY_STATUSES } from "@/lib/inventory/status";
import { capabilitiesFor } from "@/lib/leads/access";
import { ECOFY_ROLE_LABEL, ECOFY_STAGE_LABELS } from "@/lib/ecofy/access";
import { ECOFY_SEGMENTS } from "@/lib/ecofy/listTypes";
import { csvPretty } from "@/lib/leads/queueCsv";
import { businessTypeLabel } from "@/lib/leads/businessType";
import { countEvents, fetchEvents, type EventLogFilters } from "@/lib/leads/eventLog";
import { LEAD_EVENT_TYPES, parseEventTypes } from "@/lib/leads/eventTypes";
import { parseLeadListFilters } from "@/lib/leads/leadListParams";
import { ownerScopeSql } from "@/lib/users/teamSql";
import { hasLeadClocks } from "@/lib/leads/clocks";
import { loadOfficeCalendar, primeHolidayLog, workingDaysBetweenAsOfSql } from "@/lib/calendar/holidays";
import { workingHoursBetween } from "@/lib/leads/workingHours";
import { idleDays } from "@/lib/leads/idle";
import { idlePastLimitSql } from "@/lib/leads/idleLimit";
import { effectiveDoorSql } from "@/lib/leads/leadSourceDoorSql";
import { READY_NO_OWNER_TITLE, READY_SPLIT_LABEL, READY_SPLITS } from "@/lib/leads/salesReady";
import { freshRepeatJoins, isFreshSql, isNewToItarangSql, visitedRowSql } from "@/lib/visits/freshRepeat";
import { getTimeLimits, hasTimeLimitTable, limitOnDay, limitOnDaySql } from "@/lib/timeLimits/store";
import { doorLabel, LEAD_DOOR_LABEL, LEAD_DOORS, originLabel, scrapeRunLabels, SOURCE_DOOR_NONE } from "@/lib/leads/leadSourceVocab";
import { fetchScrapeRunFacets } from "@/lib/leads/acquisitionCampaigns";
import { CAMPAIGN_NONE, CAMPAIGN_SYSTEM_LABEL } from "@/lib/leads/campaign";
import { fetchCampaignFacets, fetchCampaignForLeads, type LeadCampaign } from "@/lib/leads/leadCampaign";
import { displayCampaignName } from "@/lib/leads/regionSummary";
import { onboardingStall, STALL_LABEL } from "@/lib/onboarding/stall";
import { connectedCall, engagedCall, engagedState, humanCall } from "@/lib/reports/metricDefinitions";
import { TARGET_METRIC_KEYS, TARGET_STATUS_LABEL, TARGET_STATUSES } from "@/lib/targets/rules";
import { listTargets, targetViewerFor, targetVisibleSql } from "@/lib/targets/service";

import { DOWNLOAD_ROW_CAP, initialsOf, TEAM_ROLES, type DatasetInfo, type DatasetSheet } from "./types";
import { onboardingClockSql } from "@/lib/onboarding/clock";
import { dealCardActualsSql } from "@/lib/leads/dealCardActuals";
import { BUSINESS_TYPE_OPTIONS, BUSINESS_TYPE_UNSET, BUSINESS_TYPE_UNSET_LABEL } from "@/lib/leads/businessType";
import { houseDealerCode } from "@/lib/leads/dealerByMobile";
import { LEAD_PUSHED_TO_DEALER } from "@/lib/leads/pushGuards";
import { assistedByLabel, assistedBySql } from "@/lib/exports/assistedBy";
import { billCell, exportOrigin, recordingCell } from "@/lib/exports/fileLinks";

// ID 122: the one onboarding clock (src/lib/onboarding/clock.ts).
const ONBOARDING_CLOCK = sql.raw(onboardingClockSql("app"));

type SessionUser = Awaited<ReturnType<typeof import("@/lib/auth-utils").requireAuth>>;

export interface RunContext {
    params: URLSearchParams;
    user: SessionUser;
    /** True when this role only ever gets the rows it owns. */
    ownOnly: boolean;
    /**
     * ID 155 (22 Oct): with ownOnly, the caller's direct reports today (empty
     * = not a manager) — a manager's own-rows download also carries his team,
     * as the Leads list and the Performance page do. Set by the route.
     */
    teamIds?: string[];
    /** Row ceiling for this run; absent = DOWNLOAD_ROW_CAP. A background file raises it. */
    maxRows?: number;
}

export interface Dataset extends DatasetInfo {
    count(ctx: RunContext): Promise<number>;
    build(ctx: RunContext): Promise<DatasetSheet[]>;
    /**
     * Options for select filters whose values live in the database (filter key →
     * options), merged in by the catalogue route. Fail-soft: the route keeps the
     * static options when this throws.
     */
    loadFilterOptions?(): Promise<Record<string, { value: string; label: string }[]>>;
}

const MANAGERS = ["admin", "ceo", "sales_head"] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const rows = async <T = Record<string, unknown>>(q: SQL) => (await db.execute(q)) as unknown as T[];
const jsonIds = (ids: string[]) => sql`(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`;

const IST_TODAY = sql`(now() AT TIME ZONE 'Asia/Kolkata')::date`;
const yesNo = [{ value: "1", label: "Yes" }];

/** A jsonb text value as a number, NULL when it is not one — a cast that can never throw. */
const jnum = (e: SQL): SQL => sql`(CASE WHEN (${e}) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (${e})::numeric END)`;
/** A jsonb value as an array to iterate; anything else is an empty array. */
const jarr = (e: SQL): SQL => sql`(CASE WHEN jsonb_typeof(${e}) = 'array' THEN ${e} ELSE '[]'::jsonb END)`;

/** One row past the ceiling, so the route can tell "exactly the cap" from "more". */
const rowLimit = (ctx: RunContext): SQL => sql`${(ctx.maxRows ?? DOWNLOAD_ROW_CAP) + 1}`;

/** ID 155: the own-rows clause — `col = me`, or `col IN (me, …team)` for a manager. */
const ownRows = (ctx: RunContext, col: SQL): SQL => ownerScopeSql(col, ctx.user.id, ctx.teamIds);

/** The person the shared `person` filter asks for; a rep role is never given someone else's rows. */
const personParam = (ctx: RunContext): string | null => (ctx.ownOnly ? null : ctx.params.get("person") || null);

/** The role the shared `team` filter stands for (field = ASM, inside = inside sales). */
const teamRole = (ctx: RunContext): string | null => TEAM_ROLES[ctx.params.get("team") ?? ""] ?? null;

/**
 * The filters every dataset shares (spec: "filters on every dataset"): `person`
 * and `team` against the column holding a user id, `state` against a state
 * column or, when the row only carries a lead id, that lead's state.
 */
function commonConds(ctx: RunContext, cols: { person?: SQL; state?: SQL; leadId?: SQL }): SQL[] {
    const out: SQL[] = [];
    if (cols.person) {
        const person = personParam(ctx);
        if (person) out.push(sql`${cols.person}::text = ${person}`);
        const role = teamRole(ctx);
        if (role) out.push(sql`EXISTS (SELECT 1 FROM users tu WHERE tu.id::text = ${cols.person}::text AND tu.role = ${role})`);
    }
    const state = ctx.params.get("state")?.trim();
    if (state && cols.state) out.push(sql`${cols.state} ILIKE ${state}`);
    else if (state && cols.leadId) {
        out.push(sql`EXISTS (SELECT 1 FROM dealer_leads sdl WHERE sdl.id = ${cols.leadId} AND sdl.state ILIKE ${state})`);
    }
    return out;
}

/** `from` / `to` as an inclusive range on a calendar-day expression. Default: this month, or every row. */
function dayRange(params: URLSearchParams, day: SQL, whenEmpty: "month" | "all" = "month"): SQL {
    const from = params.get("from");
    const to = params.get("to");
    const conds: SQL[] = [];
    if (from && ISO_DATE.test(from)) conds.push(sql`${day} >= ${from}::date`);
    if (to && ISO_DATE.test(to)) conds.push(sql`${day} <= ${to}::date`);
    if (conds.length === 0) {
        if (whenEmpty === "all") return sql`TRUE`;
        conds.push(sql`${day} >= date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata'))::date`);
    }
    return sql.join(conds, sql` AND `);
}

/** `from` / `to` as an IST calendar-day range on a timestamp expression. Default: this month. */
function dateRange(params: URLSearchParams, expr: SQL): SQL {
    return dayRange(params, sql`(${expr} AT TIME ZONE 'Asia/Kolkata')::date`);
}

// ───────────────────────────────── Leads ────────────────────────────────────

/**
 * The Leads columns the lead list itself does not carry, by lead id. Columns
 * added by E-314 and later are read through to_jsonb, so a database without
 * them yields blanks; a failure here never fails the download.
 */
async function leadExtras(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    if (ids.length === 0) return out;
    try {
        // ID 86 — first attempt / contact and the time-limit flags come from the
        // lead clocks (calls AND visits, E-337); without them, the old
        // calls-only rule.
        const [clocks, { holidays, hours }, tl] = await Promise.all([hasLeadClocks(), loadOfficeCalendar(), hasTimeLimitTable()]);
        // 18 Oct row 35 — the ONE idle rule (idleLimit.ts): idle_cc / idle_asm by the holder's role.
        const idlePast = idlePastLimitSql({ withTable: tl });
        const firstTouch = clocks
            ? sql`
              LEFT JOIN LATERAL (
                  SELECT c.first_attempt_at AS at, c.first_contact_at AS contact_at, c.started_at,
                         c.attempt_working_minutes, c.contact_working_minutes, c.limit_passed_at, c.start_inferred
                    FROM lead_clocks c WHERE c.dealer_lead_id = dl.id AND c.clock = 'lead' LIMIT 1) fa ON TRUE
              LEFT JOIN LATERAL (SELECT fa.contact_at AS at) fc ON TRUE
              LEFT JOIN LATERAL (
                  SELECT c.started_at, c.first_attempt_at, c.attempt_working_minutes, c.limit_passed_at, c.owner_inferred
                    FROM lead_clocks c WHERE c.dealer_lead_id = dl.id AND c.clock = 'owner'
                   ORDER BY c.started_at DESC LIMIT 1) oc ON TRUE`
            : sql`
              LEFT JOIN LATERAL (
                  SELECT MIN(t.performed_at) AS at, NULL::timestamptz AS started_at, NULL::int AS attempt_working_minutes,
                         NULL::int AS contact_working_minutes, NULL::timestamptz AS limit_passed_at, NULL::boolean AS start_inferred
                    FROM lead_touchpoints t
                   WHERE t.dealer_lead_id = dl.id AND t.touchpoint_type IN ('inside_sales_call', 'ai_call')) fa ON TRUE
              LEFT JOIN LATERAL (
                  SELECT MIN(t.performed_at) AS at FROM lead_touchpoints t
                   WHERE t.dealer_lead_id = dl.id AND t.touchpoint_type IN ('inside_sales_call', 'ai_call')
                     AND (t.call_status = 'connected' OR t.connect_status = 'connected')) fc ON TRUE
              LEFT JOIN LATERAL (
                  SELECT NULL::timestamptz AS started_at, NULL::timestamptz AS first_attempt_at, NULL::int AS attempt_working_minutes,
                         NULL::timestamptz AS limit_passed_at, NULL::boolean AS owner_inferred) oc ON TRUE`;
        const data = await rows(sql`
            SELECT dl.id AS lead_id,
                   x.j ->> 'gstin' AS gstin,
                   x.j ->> 'created_at' AS created_on,
                   ${effectiveDoorSql(sql`dl`)} AS source_door,
                   x.j ->> 'source_origin' AS source_origin,
                   cb.name AS created_by, ou.role AS owner_role,
                   x.j ->> 'sales_ready_at' AS sales_ready_on,
                   x.j ->> 'sales_ready_reason' AS sales_ready_reason,
                   x.j ->> 'assigned_at' AS assigned_on,
                   fa.at AS first_attempt_on, fc.at AS first_contact_on,
                   round(fa.attempt_working_minutes / 60.0, 1) AS hours_to_first_attempt,
                   round(fa.contact_working_minutes / 60.0, 1) AS hours_to_first_contact,
                   CASE WHEN fa.started_at IS NULL THEN NULL WHEN fa.limit_passed_at IS NULL THEN 'No' ELSE 'Yes' END AS lead_limit_passed,
                   oc.started_at AS owner_clock_from,
                   oc.first_attempt_at AS owner_first_attempt_on,
                   round(oc.attempt_working_minutes / 60.0, 1) AS owner_hours_to_first_attempt,
                   CASE WHEN oc.started_at IS NULL THEN NULL WHEN oc.limit_passed_at IS NULL THEN 'No' ELSE 'Yes' END AS owner_limit_passed,
                   CASE WHEN oc.owner_inferred THEN 'Yes' WHEN oc.started_at IS NOT NULL THEN 'No' END AS owner_inferred,
                   x.j ->> 'last_worked_at' AS last_worked_on,
                   x.j ->> 'next_follow_up_at' AS next_follow_up,
                   x.j ->> 'intent_band' AS ai_band,
                   x.j ->> 'final_intent_score' AS ai_score,
                   x.j ->> 'contactability' AS contactability,
                   x.j ->> 'last_disposition' AS last_call_outcome,
                   q.value AS quote_value, q.state AS quote_state,
                   acct.activated_at AS account_activated_on,
                   CASE WHEN dl.lead_status = 'Lost' THEN x.j ->> 'closed_at' END AS lost_on,
                   x.j ->> 'lost_reason' AS lost_reason,
                   x.j ->> 'competitor_name' AS competitor,
                   CASE WHEN ${idlePast} THEN 'Yes' WHEN dl.current_owner_id IS NOT NULL THEN 'No' END AS idle_past_limit
              FROM dealer_leads dl
             CROSS JOIN LATERAL (SELECT to_jsonb(dl) AS j) x
              LEFT JOIN users ou ON ou.id::text = x.j ->> 'current_owner_id'
              LEFT JOIN LATERAL (
                  SELECT u.name FROM lead_touchpoints t LEFT JOIN users u ON u.id::text = t.performed_by
                   WHERE t.dealer_lead_id = dl.id AND t.touchpoint_type = 'lead_created'
                   ORDER BY t.performed_at LIMIT 1) cb ON TRUE
              ${firstTouch}
              LEFT JOIN LATERAL (
                  SELECT COALESCE(${jnum(sql`c.quote_snapshot ->> 'total'`)}, c.final_price, c.price_quoted) AS value,
                         CASE WHEN c.withdrawn_at IS NOT NULL THEN 'withdrawn'
                              WHEN c.dealer_decision IS NOT NULL THEN 'dealer ' || c.dealer_decision
                              ELSE c.approval_status END AS state
                    FROM dealer_lead_commercials c
                   WHERE c.dealer_lead_id = dl.id AND c.event_type IN ('quote_issue', 'quote_revision')
                   ORDER BY c.version_no DESC LIMIT 1) q ON TRUE
              LEFT JOIN LATERAL (
                  SELECT (to_jsonb(a) ->> 'activated_at')::timestamptz AS activated_at
                    FROM accounts a JOIN account_ownership ao ON ao.account_id = a.id
                   WHERE ao.source_dealer_lead_id = dl.id LIMIT 1) acct ON TRUE
             WHERE dl.id IN ${jsonIds(ids)}
        `);
        // HANDOVER-A31 (22 Oct check): the Leads list's campaign — the latest AI
        // dialer / NeoDove campaign — from its own lookup (never throws).
        const campaigns: Record<string, LeadCampaign> = {};
        for (let i = 0; i < ids.length; i += 1_000) Object.assign(campaigns, await fetchCampaignForLeads(ids.slice(i, i + 1_000)));
        for (const r of data) {
            // created_at has no time zone and is stored as UTC.
            const created = r.created_on ? `${String(r.created_on).replace(" ", "T")}Z` : null;
            const closed = r.lost_on || r.account_activated_on;
            out.set(String(r.lead_id), {
                ...r,
                created_on: created,
                source_door: doorLabel(r.source_door as string | null),
                source_origin: originLabel(r.source_origin as string | null),
                campaign: campaigns[String(r.lead_id)]?.name ?? null,
                campaign_system: campaigns[String(r.lead_id)] ? CAMPAIGN_SYSTEM_LABEL[campaigns[String(r.lead_id)].system] : null,
                owner_role: ((r.owner_role as string | null) ?? "").replace(/_/g, " ") || null,
                // The score column defaults to 0; a lead the AI never scored shows blank, not 0.
                ai_score: r.ai_band || Number(r.ai_score) > 0 ? r.ai_score : null,
                idle_past_limit: closed ? null : (r.idle_past_limit ?? null),
                // ID 192: the Leads list / Needs Attention rule (FOLLOW_UP_AGEING_BASIS) —
                // the later of last worked, the holder's assignment and a follow-up
                // within 30 days, else created; a follow-up still ahead reads 0.
                idle_working_days: closed
                    ? null
                    : idleDays(
                          {
                              last_worked_at: (r.last_worked_on as string | null) ?? null,
                              assigned_at: (r.assigned_on as string | null) ?? null,
                              next_follow_up_at: (r.next_follow_up as string | null) ?? null,
                              created_at: created,
                          },
                          Date.now(),
                          new Set(holidays),
                          hours,
                      ),
            });
        }
    } catch (e) {
        console.error("[data-downloads] lead extras failed; those columns are blank:", (e as Error).message.split("\n")[0]);
    }
    return out;
}

/** The shared `person` filter is the lead list's own `owner_id` (the current owner). */
function leadParams(ctx: RunContext): URLSearchParams {
    const p = new URLSearchParams(ctx.params);
    const person = personParam(ctx);
    if (person) p.set("owner_id", person);
    return p;
}

const leads: Dataset = {
    id: "leads",
    label: "Leads",
    description: "Every dealer lead matching the filters, with its calls, visits and matched invoices on their own sheets.",
    roles: MANAGERS,
    ownRowsRoles: ["asm", "inside_sales_rep", "partner"],
    dateFields: [{ value: "created", label: "Lead created" }],
    commonFilters: ["person"],
    background: true,
    filters: [
        { key: "search", label: "Search (name, or mobile numbers separated by commas)", type: "text" },
        { key: "state", label: "State", type: "text" },
        { key: "city", label: "City", type: "text" },
        // ID 11 — read by parseLeadListFilters, same values as the Leads list.
        {
            key: "business_type",
            label: "Type of business",
            type: "select",
            options: [...BUSINESS_TYPE_OPTIONS, { value: BUSINESS_TYPE_UNSET, label: BUSINESS_TYPE_UNSET_LABEL }],
        },
        // HANDOVER-A31 — the Leads list's Lead source / Campaign / Scrape run
        // filters, same params (parseLeadListFilters reads them via leadParams).
        // Lead source is the effective door: stamped, else implied by the legacy source.
        {
            key: "source_door",
            label: "Lead source",
            type: "select",
            options: [...LEAD_DOORS.map((d) => ({ value: d, label: LEAD_DOOR_LABEL[d] })), { value: SOURCE_DOOR_NONE, label: "Unknown" }],
        },
        { key: "campaign", label: "Campaign", type: "select", options: [{ value: CAMPAIGN_NONE, label: "Not in a campaign" }] },
        { key: "scrape_run", label: "Scrape run", type: "select", options: [] },
        // ID 184 — the Ready to assign list (awaitingAssignment(): sales-ready, no
        // owner, open, number not dead) and its card split, same params as the
        // Leads list (parseLeadListFilters reads ready_no_owner / ready_split).
        { key: "ready_no_owner", label: `${READY_NO_OWNER_TITLE} only`, type: "select", options: yesNo },
        {
            key: "ready_split",
            label: "Ready leads: Hot / AI qualified / other (with the filter above)",
            type: "select",
            options: READY_SPLITS.map((k) => ({ value: k, label: k === "other" ? "Other" : READY_SPLIT_LABEL[k] })),
        },
    ],
    async loadFilterOptions() {
        const [campaigns, runs] = await Promise.all([fetchCampaignFacets(), fetchScrapeRunFacets()]);
        return {
            campaign: [
                { value: CAMPAIGN_NONE, label: "Not in a campaign" },
                // The Leads filter bar's label rule: NeoDove's stored name, else the derived AI-dialer title.
                ...campaigns.map((c) => ({
                    value: c.id,
                    label: `${CAMPAIGN_SYSTEM_LABEL[c.system]} · ${
                        c.system === "neodove"
                            ? c.name
                            : displayCampaignName({ category: c.category, regionFilter: c.region_filter, startedAt: c.started_at })
                    }`,
                })),
            ],
            scrape_run: scrapeRunLabels(runs).map((r) => ({ value: r.id, label: r.label })),
        };
    },
    sheets: [
        {
            name: "Leads",
            columns: [
                { key: "lead_id", header: "Lead ID", meaning: "The lead's id in the CRM.", width: 24 },
                { key: "dealer_name", header: "Dealer name", meaning: "Dealer or shop name on the lead.", width: 28 },
                { key: "phone", header: "Phone", meaning: "Dealer's mobile number. Masked unless full numbers were requested with a reason.", kind: "phone" },
                { key: "city", header: "City", meaning: "Lead's city." },
                { key: "state", header: "State", meaning: "Lead's state." },
                { key: "business_type", header: "Type of business", meaning: "Battery sale, buyback, scrap or other; 'Not set' on leads created before 17 Sep 2026." },
                { key: "lead_status", header: "Status", meaning: "Current pipeline status.", width: 22 },
                { key: "interest_level", header: "Temperature", meaning: "Hot, Warm or Cold." },
                { key: "owner_name", header: "Current owner", meaning: "Who holds the lead today. Open-lead counts follow this person.", width: 22 },
                { key: "closed_by_name", header: "Closed by", meaning: "Who held the lead when it was won or lost. Conversions are credited here and never move with reassignment.", width: 22 },
                { key: "won_at", header: "Won on", meaning: "When the rep marked the lead Won.", kind: "datetime" },
                { key: "last_visit_date", header: "Last visit", meaning: "Latest logged field visit.", kind: "date" },
                { key: "next_visit_date", header: "Next visit", meaning: "Earliest open scheduled visit from today.", kind: "date" },
                { key: "last_call_at", header: "Last call", meaning: "Latest call touchpoint.", kind: "datetime" },
                { key: "next_call_at", header: "Next call", meaning: "Earliest planned next action from now.", kind: "datetime" },
                { key: "latest_remarks", header: "Latest remarks", meaning: "Remarks on the most recent touchpoint.", width: 50 },
                { key: "invoices", header: "Invoices matched", meaning: "Count of non-void invoices matched to this lead on GSTIN.", kind: "number" },
                { key: "billed", header: "Billed (₹)", meaning: "Total of those invoices. Void excluded, drafts counted.", kind: "money" },
                { key: "last_invoice", header: "Last invoice", meaning: "Date of the latest matched invoice.", kind: "date" },
                { key: "gstin", header: "GSTIN", meaning: "GSTIN on the lead, when one was recorded." },
                { key: "created_on", header: "Created on", meaning: "When the lead was created.", kind: "datetime" },
                { key: "source_door", header: "Door", meaning: "How the lead came in (the lead-source door): the door stamped on the lead, else the one its older source field implies — the same as the Leads list." },
                { key: "source_origin", header: "Origin", meaning: "Where behind that door it came from." },
                { key: "campaign", header: "Campaign", meaning: "The lead's latest AI dialer or NeoDove campaign — the same as the Leads list's Campaign.", width: 24 },
                { key: "campaign_system", header: "Campaign system", meaning: "Which system that campaign ran on: AI Dialer or NeoDove." },
                { key: "created_by", header: "Created by", meaning: "Who created the lead. Blank on leads created before this was recorded.", width: 22 },
                { key: "owner_role", header: "Owner's role", meaning: "The current owner's role." },
                { key: "sales_ready_on", header: "Sales-ready on", meaning: "When the lead became ready for a salesperson.", kind: "datetime" },
                { key: "sales_ready_reason", header: "Sales-ready reason", meaning: "Why it was marked sales-ready." },
                { key: "assigned_on", header: "Assigned on", meaning: "When the lead was assigned to its owner.", kind: "datetime" },
                { key: "first_attempt_on", header: "First attempt on", meaning: "Lead clock (ID 86): the first call or visit by anyone after the lead became sales-ready, connected or not.", kind: "datetime" },
                { key: "first_contact_on", header: "First contact on", meaning: "Lead clock: the first call that connected or visit marked visited.", kind: "datetime" },
                { key: "hours_to_first_attempt", header: "Working hours to first attempt", meaning: "Lead clock: working hours (office hours in Admin › Time limits, holidays off) from sales-ready to the first attempt.", kind: "number" },
                { key: "hours_to_first_contact", header: "Working hours to first contact", meaning: "Lead clock: working hours from sales-ready to the first contact.", kind: "number" },
                { key: "lead_limit_passed", header: "Lead first-attempt limit passed", meaning: "Yes when no call or visit came within the lead first-attempt limit in force that day (Admin › Time limits)." },
                { key: "owner_clock_from", header: "Current owner since", meaning: "Owner clock: when the current owner got the lead.", kind: "datetime" },
                { key: "owner_first_attempt_on", header: "Owner's first attempt on", meaning: "Owner clock: the current owner's first call or visit after getting the lead.", kind: "datetime" },
                { key: "owner_hours_to_first_attempt", header: "Owner's working hours to first attempt", meaning: "Owner clock: working hours from assignment to that first attempt.", kind: "number" },
                { key: "owner_limit_passed", header: "Owner first-attempt limit passed", meaning: "Yes when the current owner did not call or visit within the owner first-attempt limit." },
                { key: "owner_inferred", header: "Owner start inferred", meaning: "Yes when no assignment record exists and the owner clock starts from the lead's assigned date instead." },
                { key: "last_worked_on", header: "Last worked on", meaning: "The last time someone worked the lead.", kind: "datetime" },
                { key: "idle_working_days", header: "Idle working days", meaning: "Working days on the office calendar (holidays off) the current holder has let it sit: counted from the latest of when it was last worked, when the holder got it and a follow-up date up to 30 days ahead, else from when it was created. A follow-up still ahead reads 0. The same count as the Leads list and Needs Attention.", kind: "number" },
                { key: "idle_past_limit", header: "Idle past limit", meaning: "Yes when the idle working days are at or past the holder's idle limit in Admin › Time limits (inside sales: 'No work on a lead held by inside sales'; ASM: '… held by an ASM') — the Needs Attention rule. Blank for closed leads and leads with no owner." },
                { key: "next_follow_up", header: "Next follow-up", meaning: "The follow-up date set on the lead.", kind: "datetime" },
                { key: "ai_band", header: "AI band", meaning: "Qualified, Warm, Cold or Disqualified, from the AI call." },
                { key: "ai_score", header: "AI score", meaning: "The AI intent score.", kind: "number" },
                { key: "contactability", header: "Contactability", meaning: "Set when the dealer cannot be reached (wrong number, do not call …)." },
                { key: "last_call_outcome", header: "Last call outcome", meaning: "The outcome of the most recent call." },
                { key: "quote_value", header: "Latest quote (₹)", meaning: "Value of the newest quote version on the lead.", kind: "money" },
                { key: "quote_state", header: "Latest quote state", meaning: "Pending, approved or rejected by iTarang; then the dealer's answer; or withdrawn." },
                { key: "account_activated_on", header: "Account activated on", meaning: "When the dealer account that came from this lead went live.", kind: "datetime" },
                { key: "lost_on", header: "Lost on", meaning: "When the lead was closed as Lost.", kind: "datetime" },
                { key: "lost_reason", header: "Lost reason", meaning: "Why it was lost.", width: 24 },
                { key: "competitor", header: "Competitor", meaning: "The competitor named when it was lost.", width: 22 },
            ],
        },
        {
            name: "Calls",
            columns: [
                { key: "lead_id", header: "Lead ID", meaning: "The lead called.", width: 24 },
                { key: "performed_at", header: "Called at", meaning: "When the call was made (IST).", kind: "datetime" },
                { key: "caller", header: "Caller", meaning: "The person who made the call. Human calls only — AI calls are not listed.", width: 22 },
                { key: "call_status", header: "Result", meaning: "Connected, not connected, and so on." },
                { key: "call_duration_sec", header: "Seconds", meaning: "Recorded duration. Duration no longer decides engagement: since 3 Oct 2026 any connected call is an engaged call.", kind: "number" },
                { key: "disposition", header: "Outcome", meaning: "The call outcome the caller picked.", width: 26 },
                { key: "remarks", header: "Remarks", meaning: "What the caller wrote.", width: 50 },
            ],
        },
        {
            name: "Visits",
            columns: [
                { key: "lead_id", header: "Lead ID", meaning: "The lead visited.", width: 24 },
                { key: "visit_date", header: "Visit date", meaning: "The actual visit date, else the scheduled one.", kind: "date" },
                { key: "visitor", header: "Visited by", meaning: "The ASM on the visit.", width: 22 },
                { key: "visit_status", header: "Status", meaning: "Scheduled, completed, cancelled." },
                { key: "visit_outcome", header: "Outcome", meaning: "The visit outcome logged.", width: 24 },
                // ID 185 — the shared Fresh / Repeat rule (src/lib/visits/freshRepeat.ts), visited rows only.
                { key: "new_visit", header: "First visit", meaning: "New to iTarang: Yes when this is the dealer's first visit by anyone (status visited); No for a later one. Blank when the row is not a visit (scheduled, cancelled, no-show)." },
                { key: "fresh_for_rep", header: "Fresh for this rep", meaning: "Yes when this is this person's first visit to the dealer (a dealer new to iTarang is also fresh); No = a repeat visit by the same person. Blank when the row is not a visit." },
                { key: "visit_remarks", header: "Remarks", meaning: "What the ASM wrote.", width: 50 },
            ],
        },
        {
            name: "Invoices",
            columns: [
                { key: "lead_id", header: "Lead ID", meaning: "The lead the invoice matched on GSTIN.", width: 24 },
                { key: "invoice_number", header: "Invoice no.", meaning: "Invoice number as printed." },
                { key: "invoice_date", header: "Invoice date", meaning: "Date on the invoice.", kind: "date" },
                { key: "customer_name", header: "Customer on invoice", meaning: "The name typed on the invoice.", width: 30 },
                { key: "total", header: "Total (₹)", meaning: "Invoice total including GST.", kind: "money" },
                { key: "status", header: "Status", meaning: "Invoice status. Void invoices are not listed." },
                { key: "source", header: "Source", meaning: "'drive' = Vyapar PDF in Google Drive; 'zoho' = the old Zoho books." },
            ],
        },
    ],
    async count(ctx) {
        return countLeadsForExport(await parseLeadListFilters(leadParams(ctx), capabilitiesFor(ctx.user.role), { ...ctx.user, teamMemberIds: ctx.teamIds }));
    },
    async build(ctx) {
        const filters = await parseLeadListFilters(leadParams(ctx), capabilitiesFor(ctx.user.role), { ...ctx.user, teamMemberIds: ctx.teamIds });
        const leadRows = await fetchLeadsForExport(filters, ctx.maxRows);
        const ids = leadRows.map((r) => r.lead_id);
        if (ids.length === 0) return this.sheets.map((s) => ({ ...s, rows: [] }));

        const invoices = await matchedUnion();
        const [calls, visits, invoiceRows] = await Promise.all([
            rows(sql`
                SELECT t.dealer_lead_id AS lead_id, t.performed_at,
                       COALESCE(u.name, t.external_agent_name) AS caller,
                       t.call_status, t.call_duration_sec, t.disposition, t.remarks
                  FROM lead_touchpoints t
                  LEFT JOIN users u ON u.id::text = t.performed_by
                 WHERE t.dealer_lead_id IN ${jsonIds(ids)} AND ${humanCall(sql`t`)}
                 ORDER BY t.dealer_lead_id, t.performed_at
            `),
            rows(sql`
                SELECT v.dealer_lead_id AS lead_id,
                       COALESCE(v.actual_visit_date, v.scheduled_date) AS visit_date,
                       u.name AS visitor, v.visit_status, v.visit_outcome, v.visit_remarks,
                       CASE WHEN ${visitedRowSql("v")} THEN ${isNewToItarangSql("v")} END AS new_visit,
                       CASE WHEN ${visitedRowSql("v")} THEN ${isFreshSql("v")} END AS fresh_for_rep
                  FROM lead_visits v
                  LEFT JOIN users u ON u.id::text = v.asm_id
                  ${freshRepeatJoins("v", true)}
                 WHERE v.dealer_lead_id IN ${jsonIds(ids)}
                 ORDER BY v.dealer_lead_id, visit_date
            `),
            rows(sql`
                SELECT r.dealer_lead_id AS lead_id, r.invoice_number, r.invoice_date, r.customer_name,
                       r.total, r.status, r.source
                  FROM ${invoices} AS r
                 WHERE r.dealer_lead_id IN ${jsonIds(ids)} AND ${REVENUE_NOT_VOID}
                 ORDER BY r.dealer_lead_id, r.invoice_date
            `),
        ]);

        const billing = new Map<string, { n: number; total: number; last: string | null }>();
        for (const i of invoiceRows) {
            const k = String(i.lead_id);
            const b = billing.get(k) ?? { n: 0, total: 0, last: null };
            // ID 71: a credit note nets the amount but is not an invoice / order.
            const credit = i.source === "credit";
            if (!credit) b.n += 1;
            b.total += Number(i.total ?? 0);
            const d = i.invoice_date ? String(i.invoice_date).slice(0, 10) : null;
            if (!credit && d && (!b.last || d > b.last)) b.last = d;
            billing.set(k, b);
        }

        const more = await leadExtras(ids);
        const [leadsSheet, callsSheet, visitsSheet, invoicesSheet] = this.sheets;
        return [
            {
                ...leadsSheet,
                rows: leadRows.map((r) => {
                    const b = billing.get(r.lead_id);
                    return {
                        ...(more.get(r.lead_id) ?? {}),
                        ...r,
                        dealer_name: r.dealer_name ?? r.shop_name,
                        business_type: businessTypeLabel(r.business_type),
                        invoices: b?.n ?? 0,
                        billed: b?.total ?? null,
                        last_invoice: b?.last ?? null,
                    };
                }),
            },
            { ...callsSheet, rows: calls },
            { ...visitsSheet, rows: visits },
            { ...invoicesSheet, rows: invoiceRows },
        ];
    },
};

// ──────────────────────────── Dealer onboarding ─────────────────────────────

const ONBOARDING_DATES: Record<string, SQL> = {
    started: sql`app.created_at`,
    submitted: sql`app.submitted_at`,
    approved: sql`app.approved_at`,
};

/**
 * ID 159 (10 Oct): the closer of the lead an onboarding came from — the
 * person credited with the dealer (dealer_leads.closing_owner_id). The form's
 * originating lead first, else a lead linked to the form.
 */
const ONBOARDING_CLOSER = sql`(SELECT cdl.closing_owner_id FROM dealer_leads cdl
     WHERE cdl.id = app.originating_dealer_lead_id
        OR cdl.dealer_onboarding_application_id::text = app.id::text
     ORDER BY (cdl.id = app.originating_dealer_lead_id) DESC NULLS LAST
     LIMIT 1)`;

function onboardingWhere(ctx: RunContext): SQL {
    // These three columns are naive UTC timestamps on this table.
    const expr = ONBOARDING_DATES[ctx.params.get("date_field") ?? "started"] ?? ONBOARDING_DATES.started;
    const conds: SQL[] = [dateRange(ctx.params, sql`(${expr} AT TIME ZONE 'UTC')`)];
    const status = ctx.params.get("status");
    if (status) conds.push(sql`app.onboarding_status = ${status}`);
    const salesperson = ctx.params.get("salesperson");
    if (salesperson) conds.push(sql`app.salesperson_user_id::text = ${salesperson}`);
    // ID 159: the Person / Team filters pick the lead's closer — the credit —
    // and fall back to the form's salesperson when there is no lead.
    conds.push(...commonConds(ctx, { person: sql`COALESCE(${ONBOARDING_CLOSER}, app.salesperson_user_id::text)` }));
    return sql.join(conds, sql` AND `);
}

const dealerOnboarding: Dataset = {
    id: "dealer_onboarding",
    label: "Dealer onboarding",
    description: "One row per dealer onboarding, with its salesperson, linked lead and agreement status.",
    roles: MANAGERS,
    dateFields: [
        { value: "started", label: "Started" },
        { value: "submitted", label: "Submitted" },
        { value: "approved", label: "Approved" },
    ],
    commonFilters: ["team", "person"],
    background: true,
    filters: [
        {
            key: "status",
            label: "Status",
            type: "select",
            // ID 169: "withdrawn" — a form closed by Undo Mark Won.
            options: ["draft", "submitted", "approved", "rejected", "withdrawn"].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })),
        },
    ],
    sheets: [
        {
            name: "Dealer onboarding",
            columns: [
                { key: "id", header: "Onboarding ID", meaning: "The onboarding application's id.", width: 38 },
                { key: "company_name", header: "Dealer", meaning: "Company name on the application.", width: 30 },
                { key: "owner_phone", header: "Phone", meaning: "Owner's mobile. Masked unless full numbers were requested with a reason.", kind: "phone" },
                { key: "gst_number", header: "GSTIN", meaning: "GSTIN on the application." },
                { key: "dealer_type", header: "Dealer type", meaning: "New battery, scrap, or both." },
                { key: "started_on", header: "Started on", meaning: "When the onboarding was first saved.", kind: "datetime" },
                { key: "started_through", header: "Started through", meaning: "Web wizard, WhatsApp, or from a won lead." },
                { key: "salesperson", header: "Salesperson (on the form)", meaning: "The ISR, ASM or Sales Head picked on the onboarding — information, not credit. Blank on older onboardings — approval is blocked until it is set.", width: 22 },
                { key: "lead_closed_by", header: "Lead closed by (credit)", meaning: "Who closed the linked lead — the person credited with this dealer. The Person and Team filters use this; blank for a direct onboarding.", width: 22 },
                { key: "lead_id", header: "Linked lead ID", meaning: "The dealer lead this onboarding came from; blank for a direct onboarding.", width: 24 },
                { key: "onboarding_status", header: "Status", meaning: "Draft, submitted, approved, rejected or withdrawn (closed by Undo Mark Won)." },
                { key: "withdrawn_reason", header: "Why withdrawn", meaning: "Why a withdrawn onboarding was closed, e.g. 'Marked Won by mistake'.", width: 28 },
                { key: "submitted_at", header: "Documents submitted on", meaning: "When the dealer submitted the application.", kind: "datetime" },
                { key: "finance_enabled", header: "Customer finance", meaning: "Whether the dealer asked for customer finance." },
                { key: "agreement_status", header: "Agreement status", meaning: "Where the dealer agreement stands; 'completed' means signed by every party. 'N/A' when finance is off." },
                { key: "agreement_signed_on", header: "Agreement signed on", meaning: "The date the agreement was fully signed.", kind: "date" },
                { key: "approved_at", header: "Approved on", meaning: "When the dealer was activated.", kind: "datetime" },
                { key: "approved_by", header: "Approved by", meaning: "Who activated the dealer.", width: 22 },
                { key: "rejection_reason", header: "Rejection reason", meaning: "Why it was rejected, when it was.", width: 40 },
                { key: "times_sent_back", header: "Times sent back", meaning: "How many times the application was sent back to the dealer for corrections.", kind: "number" },
                { key: "stalled", header: "Stalled", meaning: "Set when an open onboarding has waited on the dealer, or on iTarang, longer than its limit in Admin › Time limits (defaults 7 days / 2 working days).", width: 26 },
                { key: "dropout_reason", header: "Drop-out reason", meaning: "Why the dealer dropped out, when the linked lead records one.", width: 24 },
            ],
        },
    ],
    async count(ctx) {
        const [r] = await rows<{ n: number }>(sql`
            SELECT COUNT(*)::int AS n FROM dealer_onboarding_applications app WHERE ${onboardingWhere(ctx)}
        `);
        return Number(r?.n ?? 0);
    },
    async build(ctx) {
        const data = await rows(sql`
            SELECT app.id::text AS id, app.company_name, app.owner_phone, app.gst_number, app.dealer_type,
                   (app.created_at AT TIME ZONE 'UTC')   AS started_on,
                   COALESCE(to_jsonb(app) ->> 'onboarding_channel', to_jsonb(app) ->> 'source',
                            CASE WHEN app.originating_dealer_lead_id IS NOT NULL THEN 'lead' ELSE 'web' END) AS started_through,
                   sp.name AS salesperson,
                   (SELECT COALESCE(cu.name, cu.email) FROM users cu WHERE cu.id::text = ${ONBOARDING_CLOSER}) AS lead_closed_by,
                   to_jsonb(app) ->> 'withdrawn_reason' AS withdrawn_reason,
                   COALESCE(app.originating_dealer_lead_id,
                            (SELECT dl.id FROM dealer_leads dl
                              WHERE dl.dealer_onboarding_application_id::text = app.id::text LIMIT 1)) AS lead_id,
                   app.onboarding_status,
                   (app.submitted_at AT TIME ZONE 'UTC') AS submitted_at,
                   app.finance_enabled,
                   CASE WHEN app.finance_enabled THEN app.agreement_status ELSE 'N/A' END AS agreement_status,
                   COALESCE(app.agreement_signed_on, (app.agreement_completed_at AT TIME ZONE 'UTC')::date) AS agreement_signed_on,
                   (app.approved_at AT TIME ZONE 'UTC')  AS approved_at,
                   ab.name AS approved_by,
                   app.rejection_reason,
                   (SELECT COUNT(*) FROM dealer_correction_rounds cr WHERE cr.application_id::text = app.id::text) AS times_sent_back,
                   (${ONBOARDING_CLOCK} AT TIME ZONE 'UTC') AS last_activity_at,
                   (SELECT dl.onboarding_dropout_reason FROM dealer_leads dl
                     WHERE dl.id = app.originating_dealer_lead_id
                        OR dl.dealer_onboarding_application_id::text = app.id::text
                     ORDER BY dl.onboarding_dropout_reason NULLS LAST LIMIT 1) AS dropout_reason
              FROM dealer_onboarding_applications app
              LEFT JOIN users sp ON sp.id = app.salesperson_user_id
              LEFT JOIN users ab ON ab.id = app.approved_by
             WHERE ${onboardingWhere(ctx)}
             ORDER BY app.created_at DESC
             LIMIT ${rowLimit(ctx)}
        `);
        // ID 85 — the office calendar and the stall limits in force today.
        const [{ holidays, hours }, limits] = await Promise.all([loadOfficeCalendar(), getTimeLimits()]);
        const stallLimits = { dealerDays: limits.onboarding_stall_dealer, usWorkingDays: limits.onboarding_stall_us };
        return [
            {
                ...this.sheets[0],
                rows: data.map((r) => {
                    const on = onboardingStall(
                        {
                            onboarding_status: (r.onboarding_status as string | null) ?? null,
                            agreement_status: r.finance_enabled ? ((r.agreement_status as string | null) ?? null) : null,
                            last_activity_at: (r.last_activity_at as string | Date | null) ?? null,
                        },
                        new Set(holidays),
                        new Date(),
                        stallLimits,
                        hours,
                    );
                    return { ...r, stalled: on ? STALL_LABEL[on] : null };
                }),
            },
        ];
    },
};

// ─────────────────────────── Customer loan files ────────────────────────────

const LOAN_DATES: Record<string, SQL> = {
    submitted: sql`q.submitted_on`,
    decided: sql`COALESCE(ls.sanctioned_at, ls.updated_at)`,
    disbursed: sql`ls.disbursed_at`,
};

/** One file per customer lead that reached KYC review, with its latest loan decision. */
const loanFrom = sql`
      FROM leads l
      JOIN LATERAL (
          SELECT MIN(COALESCE(v.submitted_at, v.created_at)) AS submitted_on
            FROM admin_verification_queue v WHERE v.lead_id = l.id::text
      ) q ON q.submitted_on IS NOT NULL
      LEFT JOIN LATERAL (
          SELECT s.* FROM loan_sanctions s WHERE s.lead_id = l.id ORDER BY s.created_at DESC LIMIT 1
      ) ls ON TRUE
      LEFT JOIN nbfc_tenants nt ON nt.id = ls.nbfc_id
      LEFT JOIN accounts a ON a.id = l.dealer_id
      -- ID 146: the one owner model (E-321 account_ownership). accounts.account_owner_id
      -- was the retired second build (E-322_account_owner_model, db-1 only).
      LEFT JOIN account_ownership aown ON aown.account_id = a.id
      LEFT JOIN users ow ON ow.id = aown.owner_user_id
`;

function loanWhere(ctx: RunContext): SQL {
    const expr = LOAN_DATES[ctx.params.get("date_field") ?? "submitted"] ?? LOAN_DATES.submitted;
    // These columns are timestamptz (admin_verification_queue, loan_sanctions):
    // dateRange's own AT TIME ZONE 'Asia/Kolkata' already gives the IST day.
    // An extra AT TIME ZONE 'UTC' first (right only for the zone-less onboarding
    // columns) shifted every bound by 5h30.
    const conds: SQL[] = [dateRange(ctx.params, expr)];
    const status = ctx.params.get("status");
    if (status) conds.push(sql`lower(ls.status) = ${status.toLowerCase()}`);
    const nbfc = ctx.params.get("nbfc");
    if (nbfc) conds.push(sql`ls.nbfc_id::text = ${nbfc}`);
    conds.push(...commonConds(ctx, { person: sql`aown.owner_user_id` }));
    return sql.join(conds, sql` AND `);
}

const customerLoanFiles: Dataset = {
    id: "customer_loan_files",
    label: "Customer loan files",
    description: "One row per customer file that reached KYC review, with the lender's decision. The customer is shown by initials only.",
    roles: MANAGERS,
    dateFields: [
        { value: "submitted", label: "Submitted" },
        { value: "decided", label: "Decided" },
        { value: "disbursed", label: "Disbursed" },
    ],
    commonFilters: ["person"],
    background: true,
    filters: [{ key: "status", label: "Loan status (e.g. sanctioned, rejected, disbursed)", type: "text" }],
    sheets: [
        {
            name: "Customer loan files",
            columns: [
                { key: "file_id", header: "File ID", meaning: "The customer lead's id.", width: 26 },
                { key: "submitted_on", header: "Submitted on", meaning: "When the file first reached KYC review.", kind: "datetime" },
                { key: "dealer", header: "Dealer account", meaning: "The dealer the file is with today. For a file iTarang raised and pushed to a dealer, that dealer — see 'Pushed by iTarang'.", width: 28 },
                { key: "pushed_by_itarang_on", header: "Pushed by iTarang (date)", meaning: "When iTarang raised this file under its own house dealer and pushed it to the dealer above (the latest such push). Blank for a file the dealer raised.", kind: "datetime" },
                { key: "pushed_by", header: "Pushed by", meaning: "The iTarang person who made that push.", width: 22 },
                { key: "pushed_to", header: "Pushed to", meaning: "The dealer that push sent the file to.", width: 28 },
                { key: "assisted_by", header: "Assisted by (iTarang)", meaning: "iTarang people who did steps on this file for the dealer ('Done by <name> for <dealer>'), A–Z, with how many steps. The dealer keeps the credit for the file. Blank when the dealer did every step.", width: 30 },
                { key: "account_owner", header: "Account owner", meaning: "The salesperson who owns that dealer account today.", width: 22 },
                { key: "customer", header: "Customer", meaning: "Customer's initials only — the name, phone and identity numbers are never downloaded." },
                { key: "city", header: "City", meaning: "Customer's city." },
                { key: "kyc_status", header: "KYC status", meaning: "Where the applicant's KYC stands." },
                { key: "nbfc", header: "NBFC", meaning: "The lender on the latest loan decision.", width: 24 },
                { key: "loan_file_number", header: "Loan file no.", meaning: "The lender's file number." },
                { key: "loan_status", header: "Loan status", meaning: "The latest decision: sanctioned, rejected, disbursed, and so on. Blank when no lender has decided." },
                { key: "rejection_reason", header: "Rejection reason", meaning: "The lender's reason, when rejected.", width: 36 },
                { key: "decided_on", header: "Decided on", meaning: "When the lender sanctioned or rejected.", kind: "datetime" },
                { key: "loan_amount", header: "Loan amount (₹)", meaning: "Sanctioned loan amount.", kind: "money" },
                { key: "disbursed_at", header: "Disbursed on", meaning: "When the loan was disbursed.", kind: "datetime" },
                { key: "disbursement_amount", header: "Disbursed (₹)", meaning: "Amount disbursed.", kind: "money" },
            ],
        },
    ],
    async count(ctx) {
        const [r] = await rows<{ n: number }>(sql`SELECT COUNT(*)::int AS n ${loanFrom} WHERE ${loanWhere(ctx)}`);
        return Number(r?.n ?? 0);
    },
    async build(ctx) {
        // ID 33: a file the house dealer pushed out — the LEAD_PUSHED_TO_DEALER
        // row whose from_dealer_id is the house (src/lib/leads/pushGuards.ts).
        // No house dealer configured → the comparison is NULL and the columns stay blank.
        const house = await houseDealerCode();
        const data = await rows(sql`
            SELECT l.id::text AS file_id,
                   q.submitted_on AS submitted_on,
                   a.business_entity_name AS dealer, ow.name AS account_owner,
                   hp.pushed_at AS pushed_by_itarang_on, hp.pushed_by, hp.pushed_to,
                   ${assistedBySql(sql`l.id`)} AS assisted,
                   COALESCE(l.full_name, l.owner_name) AS customer_name,
                   l.city, l.kyc_status,
                   COALESCE(nt.display_name, ls.external_lender) AS nbfc,
                   ls.loan_file_number, ls.status AS loan_status, ls.rejection_reason,
                   COALESCE(ls.sanctioned_at, CASE WHEN lower(ls.status) = 'rejected' THEN ls.updated_at END) AS decided_on,
                   ls.loan_amount,
                   ls.disbursed_at AS disbursed_at,
                   ls.disbursement_amount
              ${loanFrom}
              LEFT JOIN LATERAL (
                  SELECT pa.timestamp AS pushed_at,
                         COALESCE(pu.name, pa.changes ->> 'by_name') AS pushed_by,
                         COALESCE(pa.changes ->> 'to_dealer_name', pta.business_entity_name, pa.changes ->> 'to_dealer_id') AS pushed_to
                    FROM audit_logs pa
                    LEFT JOIN users pu ON pu.id = pa.performed_by
                    LEFT JOIN accounts pta ON pta.id = pa.changes ->> 'to_dealer_id'
                   WHERE pa.entity_type = 'lead' AND pa.entity_id = l.id::text
                     AND pa.action = ${LEAD_PUSHED_TO_DEALER}
                     AND pa.changes ->> 'from_dealer_id' = ${house}
                   ORDER BY pa.timestamp DESC
                   LIMIT 1
              ) hp ON TRUE
             WHERE ${loanWhere(ctx)}
             ORDER BY q.submitted_on DESC
             LIMIT ${rowLimit(ctx)}
        `);
        return [
            {
                ...this.sheets[0],
                rows: data.map(({ customer_name, assisted, ...r }) => ({
                    ...r,
                    customer: initialsOf(customer_name as string | null),
                    assisted_by: assistedByLabel(assisted),
                })),
            },
        ];
    },
};

// ───────────────────────────── Dealer accounts ──────────────────────────────

function accountFilters(ctx: RunContext) {
    const bucket = ctx.params.get("bucket");
    const came = ctx.params.get("came_through");
    return {
        ownerId: ctx.ownOnly ? ctx.user.id : ctx.params.get("owner") || personParam(ctx),
        cameThrough: came === "lead" || came === "direct" ? (came as "lead" | "direct") : null,
        bucket: (ACCOUNT_BUCKETS as readonly string[]).includes(bucket ?? "") ? (bucket as AccountBucket) : null,
        noOwnerOnly: !ctx.ownOnly && ctx.params.get("no_owner") === "1",
        gstinMissingOnly: ctx.params.get("gstin_missing") === "1",
        search: ctx.params.get("search"),
    };
}

/** The account list, with the shared `state` filter applied (the list itself has none). */
async function accountRows(ctx: RunContext) {
    const state = ctx.params.get("state")?.trim().toLowerCase();
    const list = await listAccounts(accountFilters(ctx));
    return state ? list.filter((r) => (r.state ?? "").toLowerCase() === state) : list;
}

const dealerAccounts: Dataset = {
    id: "dealer_accounts",
    label: "Dealer accounts",
    description: "Every activated dealer with its owner, how it came in, last invoice and health. Not date-ranged: it is the dealer base as it stands today. A dealer closed by hand shows Health \"Closed\" with the reason, date and who closed it; the \"No owner\" and \"GSTIN missing\" filters leave closed dealers out (as the Accounts tabs count them) unless Health = Closed is picked.",
    roles: MANAGERS,
    ownRowsRoles: ["asm", "inside_sales_rep"],
    dateFields: [],
    commonFilters: ["person", "state"],
    filters: [
        { key: "came_through", label: "Came through", type: "select", options: [{ value: "lead", label: "Lead" }, { value: "direct", label: "Direct onboarding" }] },
        { key: "bucket", label: "Health", type: "select", options: ACCOUNT_BUCKETS.map((b) => ({ value: b, label: ACCOUNT_BUCKET_LABELS[b] })) },
        { key: "no_owner", label: "No owner only", type: "select", options: [{ value: "1", label: "Yes" }] },
        { key: "gstin_missing", label: "GSTIN missing only", type: "select", options: yesNo },
        { key: "search", label: "Search (dealer, GSTIN or city)", type: "text" },
    ],
    sheets: [
        {
            name: "Dealer accounts",
            columns: [
                { key: "account_id", header: "Account ID", meaning: "The dealer account's id (the dealer code).", width: 30 },
                { key: "dealer", header: "Dealer", meaning: "Business name on the account.", width: 30 },
                { key: "gstin", header: "GSTIN", meaning: "The account's GSTIN; 'PENDING' when none has been recorded yet." },
                { key: "city", header: "City", meaning: "Account's city." },
                { key: "state", header: "State", meaning: "Account's state." },
                { key: "business_type", header: "Type of business", meaning: "From the lead the dealer came through; 'Not set' for a direct onboarding or an older lead." },
                { key: "dealer_type", header: "Dealer type", meaning: "New battery, scrap, or both." },
                { key: "finance_enabled", header: "Customer finance on", meaning: "Whether the dealer can raise customer finance files." },
                { key: "agreement_status", header: "Agreement", meaning: "Status of the dealer agreement." },
                { key: "came_through", header: "Came through", meaning: "'lead' = won from a dealer lead; 'direct' = onboarded with no lead." },
                { key: "lead_id", header: "Lead ID", meaning: "The lead it came through, when it did.", width: 24 },
                { key: "onboarded_by_name", header: "Onboarded by", meaning: "The salesperson named on the onboarding form — information, not credit (credit goes to the lead's closer). Fixed; never changes.", width: 22 },
                { key: "owner_name", header: "Account owner", meaning: "Who looks after the account now. Blank = no owner yet.", width: 22 },
                { key: "owner_since", header: "Owner since", meaning: "The effective date of the current owner.", kind: "date" },
                { key: "activated_on", header: "Activated on", meaning: "When the dealer went live (admin approval).", kind: "date" },
                { key: "first_order", header: "First invoice", meaning: "Date of the first invoice matched to the account's GSTIN.", kind: "date" },
                { key: "last_order", header: "Last invoice", meaning: "Date of the latest matched invoice.", kind: "date" },
                { key: "days_since_last_order", header: "Days since last invoice", meaning: "Calendar days (IST) since the last invoice. Blank = never invoiced.", kind: "number" },
                { key: "bucket_label", header: "Health", meaning: "Active 0–20 days, Cooling 21–30, Orange 31–45, Red 46–60, Dormant 60+; never invoiced: Not ordered yet (≤30 days since activation) or Never ordered; an open \"Order placed\" pauses the ageing (same as Dealer Health). Closed = closed by hand — not counted as a live dealer anywhere.", width: 30 },
                { key: "closed_reason", header: "Closed reason", meaning: "Why the dealer was closed by hand (\"Lost / closed dealer\"). Blank = not closed.", width: 30 },
                { key: "closed_on", header: "Closed on", meaning: "The day (IST) the dealer was closed. Blank = not closed.", kind: "date" },
                { key: "closed_by_name", header: "Closed by", meaning: "Who closed the dealer. Blank = not closed.", width: 22 },
                { key: "revenue_90d", header: "Billed, last 90 days (₹)", meaning: "Invoice totals in the last 90 days. Void excluded, drafts counted.", kind: "money" },
                { key: "revenue_fy", header: "Billed, this FY (₹)", meaning: "Invoice totals since 1 April.", kind: "money" },
                { key: "revenue_lifetime", header: "Billed, lifetime (₹)", meaning: "Invoice totals, all time. Void excluded, drafts counted.", kind: "money" },
                { key: "orders", header: "Invoices", meaning: "Count of matched invoices, all time.", kind: "number" },
                { key: "avg_reorder_days", header: "Average days between orders", meaning: "Days from first to last invoice ÷ (days with an invoice − 1). Blank until there are two order days.", kind: "number" },
                { key: "invoices_matchable", header: "Invoices can be matched", meaning: "'No' = no GSTIN on the account and no lead behind it, so its invoices cannot be seen; its health is not reliable until the GSTIN is set." },
            ],
        },
    ],
    async count(ctx) {
        return (await accountRows(ctx)).length;
    },
    async build(ctx) {
        const data = await accountRows(ctx);
        return [
            {
                ...this.sheets[0],
                rows: data.map((r) => ({
                    ...r,
                    business_type: businessTypeLabel(r.business_type),
                    bucket_label: ACCOUNT_BUCKET_LABELS[r.bucket],
                    invoices_matchable: r.invoices_unmatchable ? "No" : "Yes",
                })),
            },
        ];
    },
};

// ─────────────────────────────── Lead events ────────────────────────────────

/** The event log wants both dates. Default: this month to today (IST, from Postgres). */
async function eventFilters(ctx: RunContext): Promise<EventLogFilters> {
    const { params } = ctx;
    const performerId = personParam(ctx) ?? undefined;
    // ID 34 — "call,visit"; nothing ticked (or all) = every event type.
    const eventTypes = parseEventTypes(params.get("event_type"));
    const from = params.get("from");
    const to = params.get("to");
    const okFrom = from && ISO_DATE.test(from) ? from : null;
    const okTo = to && ISO_DATE.test(to) ? to : null;
    const [d] = await rows<{ first: string; today: string }>(sql`
        SELECT date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date::text AS first, ${IST_TODAY}::text AS today
    `);
    if (!okFrom && !okTo) return { from: d.first, to: d.today, performerId, eventTypes };
    return { from: okFrom ?? "2000-01-01", to: okTo ?? d.today, performerId, eventTypes };
}

const leadEvents: Dataset = {
    id: "lead_events",
    label: "Lead events",
    description: "The event log: one row per thing that happened to a lead — created, re-inquiry, sales-ready, status, owner, interest and contactability changes, calls, visits, quotes, escalations, field edits. The date range is the date of the event, not of the lead.",
    roles: MANAGERS,
    dateFields: [{ value: "event", label: "Event time" }],
    commonFilters: ["person"],
    // ID 34 — pick the event types here instead of filtering in Excel.
    filters: [
        { key: "event_type", label: "Event type", type: "multiselect", options: LEAD_EVENT_TYPES.map((t) => ({ value: t.value, label: t.label })) },
    ],
    sheets: [
        {
            name: "Lead events",
            columns: [
                { key: "event_at", header: "Event time", meaning: "When it happened (IST).", kind: "datetime" },
                { key: "lead_id", header: "Lead ID", meaning: "The lead the event is on.", width: 24 },
                { key: "lead_created_at", header: "Lead created at", meaning: "When the lead was created (IST).", kind: "datetime" },
                { key: "dealer", header: "Dealer / shop", meaning: "Shop or dealer name on the lead.", width: 28 },
                { key: "city", header: "City", meaning: "Lead's city." },
                { key: "state", header: "State", meaning: "Lead's state." },
                { key: "business_type", header: "Type of business", meaning: "Battery sale, buyback, scrap or other." },
                { key: "event_type", header: "Event type", meaning: `One of: ${LEAD_EVENT_TYPES.map((t) => t.label).join(", ")}.`, width: 22 },
                { key: "from_value", header: "From", meaning: "The value before the change, when the event is a change.", width: 22 },
                { key: "to_value", header: "To", meaning: "The value after the change. Lead created: how it came in. Sales-ready: the reason. Contactability change: dead number, non-responsive or cleared.", width: 26 },
                { key: "performed_by", header: "Done by", meaning: "Who did it. Blank = the system, or not recorded.", width: 20 },
                { key: "role", header: "Role", meaning: "That person's role today." },
                { key: "channel", header: "Channel", meaning: "For calls and messages: where it came from." },
                { key: "outcome", header: "Outcome", meaning: "Call or visit outcome, or the lost reason on a status change.", width: 24 },
                { key: "duration_sec", header: "Seconds", meaning: "Call duration, when recorded.", kind: "number" },
                { key: "remarks", header: "Remarks", meaning: "What was written on the event.", width: 50 },
                { key: "hours_since_sales_ready", header: "Working hours since sales-ready", meaning: "Working hours (office hours in Admin › Time limits, holidays off) from the lead becoming sales-ready to this event — the lead clock's time. Blank when the lead was never marked sales-ready, or the event came first.", kind: "number" },
                // ID 35 — the clocks running when the event happened (E-337 lead_clocks).
                { key: "lead_clock_started_at", header: "Lead clock started", meaning: "When the lead's clock (sales-ready → first call or visit by anyone) started, if it had started by this event. Blank = no lead clock yet.", kind: "datetime" },
                { key: "lead_limit_passed", header: "Lead limit passed", meaning: "Had the lead clock passed its limit by this event: No, or Yes with when (IST). Blank = no lead clock.", width: 22 },
                { key: "owner_clock_started_at", header: "Owner clock started", meaning: "When the clock of the owner holding the lead at this event started (their assignment → their first call or visit). Blank = no owner clock covers the event.", kind: "datetime" },
                { key: "owner_limit_passed", header: "Owner limit passed", meaning: "Had that owner clock passed its limit by this event: No, or Yes with when (IST). Blank = no owner clock.", width: 22 },
                { key: "owner_inferred", header: "Owner inferred", meaning: "Yes = that owner was inferred from the lead's assigned date because no assignment record exists (back-filled). Blank = no owner clock." },
                // 18 Oct row 36 — which event stopped each clock.
                { key: "lead_first_attempt", header: "Lead's first attempt", meaning: "Yes = this call or visit is the lead's first attempt by anyone after it became sales-ready (it stopped the lead clock)." },
                { key: "lead_first_contact", header: "Lead's first contact", meaning: "Yes = this is the lead's first connected call or visit marked visited after it became sales-ready." },
                { key: "owner_first_attempt", header: "Owner's first attempt", meaning: "Yes = this call or visit is the first by the owner holding the lead (it stopped the owner clock)." },
                { key: "owner_first_contact", header: "Owner's first contact", meaning: "Yes = this is that owner's first connected call or visit marked visited." },
            ],
        },
    ],
    async count(ctx) {
        return countEvents(await eventFilters(ctx));
    },
    async build(ctx) {
        const [events, cal] = await Promise.all([fetchEvents(await eventFilters(ctx)), loadOfficeCalendar()]);
        return [
            {
                ...this.sheets[0],
                rows: events.map((e) => {
                  // IST wall-clock text from SQL → an instant the file can show as IST.
                  const ist = (t: string | null | undefined) => (t ? `${t.replace(" ", "T").slice(0, 19)}+05:30` : null);
                  const at = ist(e.event_at);
                  // 18 Oct row 36: working hours on the office calendar, like the lead clock.
                  const ready = e.sales_ready_at ? new Date(e.sales_ready_at) : null;
                  const gap = at && ready && new Date(at) >= ready ? workingHoursBetween(ready, new Date(at), cal.holidays, cal.hours) : null;
                  return {
                    ...e,
                    event_at: at,
                    lead_created_at: ist(e.lead_created_at),
                    lead_clock_started_at: ist(e.lead_clock_started_at),
                    owner_clock_started_at: ist(e.owner_clock_started_at),
                    hours_since_sales_ready: gap != null && Number.isFinite(gap) && gap >= 0 ? Math.round(gap * 10) / 10 : null,
                    business_type: businessTypeLabel(e.business_type),
                    role: (e.role ?? "").replace(/_/g, " ") || null,
                  };
                }),
            },
        ];
    },
};

// ────────────────────────────────── Calls ───────────────────────────────────

const AI_CALL = sql`(t.touchpoint_type = 'ai_call')`;
/** Connected: an AI call by its own connect status, a human call by the dashboards' rule. */
const CALL_CONNECTED = sql`(CASE WHEN t.touchpoint_type = 'ai_call' THEN t.connect_status = 'connected' ELSE (${connectedCall(sql`t`)}) END)`;

function callsWhere(ctx: RunContext): SQL {
    const t = sql`t`;
    const conds: SQL[] = [sql`((${humanCall(t)}) OR ${AI_CALL})`, dateRange(ctx.params, sql`t.performed_at`)];
    if (ctx.ownOnly) conds.push(ownRows(ctx, sql`t.performed_by`));
    const channel = ctx.params.get("channel");
    if (channel === "neodove") conds.push(sql`NOT ${AI_CALL} AND t.external_system = 'neodove'`);
    if (channel === "rep") conds.push(sql`NOT ${AI_CALL} AND t.external_system IS DISTINCT FROM 'neodove'`);
    if (channel === "ai") conds.push(AI_CALL);
    const connected = ctx.params.get("connected");
    if (connected === "yes") conds.push(sql`${CALL_CONNECTED} IS TRUE`);
    if (connected === "no") conds.push(sql`${CALL_CONNECTED} IS NOT TRUE`);
    if (ctx.params.get("engaged") === "1") conds.push(sql`(${engagedCall(t)})`);
    conds.push(...commonConds(ctx, { person: sql`t.performed_by`, leadId: sql`t.dealer_lead_id` }));
    return sql.join(conds, sql` AND `);
}

const calls: Dataset = {
    id: "calls",
    label: "Calls",
    description: "One row per call on a dealer lead — NeoDove, rep-logged and the AI dialler.",
    roles: MANAGERS,
    ownRowsRoles: ["asm", "inside_sales_rep"],
    dateFields: [{ value: "called", label: "Call time" }],
    commonFilters: ["team", "person", "state"],
    background: true,
    filters: [
        { key: "channel", label: "Channel", type: "select", options: [{ value: "neodove", label: "NeoDove" }, { value: "rep", label: "Rep-logged" }, { value: "ai", label: "AI dialler" }] },
        { key: "connected", label: "Connected", type: "select", options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] },
        { key: "engaged", label: "Engaged only", type: "select", options: yesNo },
    ],
    sheets: [
        {
            name: "Calls",
            columns: [
                { key: "performed_at", header: "Called at", meaning: "When the call was made (IST).", kind: "datetime" },
                { key: "lead_id", header: "Lead ID", meaning: "The lead called.", width: 24 },
                { key: "dealer", header: "Dealer", meaning: "Dealer or shop name on the lead.", width: 28 },
                { key: "city", header: "City", meaning: "Lead's city." },
                { key: "state", header: "State", meaning: "Lead's state." },
                { key: "caller", header: "Caller", meaning: "The person who made the call; 'AI Dialer' for an AI call.", width: 22 },
                { key: "caller_role", header: "Role", meaning: "The caller's role today." },
                { key: "channel", header: "Channel", meaning: "'NeoDove' = came from the dialler; 'Rep-logged' = typed into the CRM; 'AI dialler' = made by the AI." },
                { key: "neodove_agent", header: "NeoDove agent", meaning: "Agent name NeoDove sent with the call.", width: 22 },
                { key: "connected", header: "Connected", meaning: "Yes when the call connected — the same rule the dashboards count." },
                { key: "call_status", header: "Result", meaning: "The call status as stored." },
                { key: "disposition_bucket", header: "Outcome bucket", meaning: "The outcome's group (positive, negative, follow-up …)." },
                { key: "disposition", header: "Outcome", meaning: "The call outcome the caller picked.", width: 26 },
                { key: "call_duration_sec", header: "Seconds", meaning: "Recorded duration.", kind: "number" },
                { key: "engaged", header: "Engaged", meaning: "Yes = a connected call where the rep spoke with the dealer, any duration; on an AI call, the flag stored with the call." },
                { key: "ai_band", header: "AI band", meaning: "On an AI call: Qualified, Warm, Cold or Disqualified." },
                { key: "recording_url", header: "Recording", meaning: "A CRM link to the recording, when there is one. Clicking it checks who you are (logged in, allowed to hear this call) and then plays it through a fresh link that lasts 15 minutes; the file itself never sits in this download. A recording still only on NeoDove says so instead.", width: 40 },
                { key: "remarks", header: "Remarks", meaning: "What the caller wrote; on an AI call, the AI's summary.", width: 50 },
            ],
        },
    ],
    async count(ctx) {
        const [r] = await rows<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM lead_touchpoints t WHERE ${callsWhere(ctx)}`);
        return Number(r?.n ?? 0);
    },
    async build(ctx) {
        const t = sql`t`;
        const data = await rows(sql`
            SELECT t.performed_at, t.dealer_lead_id AS lead_id,
                   COALESCE(dl.dealer_name, dl.shop_name) AS dealer, dl.city, dl.state,
                   CASE WHEN ${AI_CALL} THEN 'AI Dialer' ELSE COALESCE(u.name, t.external_agent_name) END AS caller,
                   u.role AS caller_role,
                   CASE WHEN ${AI_CALL} THEN 'AI dialler'
                        WHEN t.external_system = 'neodove' THEN 'NeoDove' ELSE 'Rep-logged' END AS channel,
                   t.external_agent_name AS neodove_agent,
                   ${CALL_CONNECTED} AS connected,
                   t.call_status, t.disposition_bucket, t.disposition, t.call_duration_sec,
                   ${engagedState(t)} AS engaged,
                   (SELECT a.band FROM ai_call_logs a
                     WHERE ${AI_CALL} AND a.call_id = t.external_event_id LIMIT 1) AS ai_band,
                   t.recording_url, t.remarks,
                   CASE WHEN ${AI_CALL} THEN t.external_event_id END AS ai_call_id
              FROM lead_touchpoints t
              LEFT JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
              LEFT JOIN users u ON u.id::text = t.performed_by
             WHERE ${callsWhere(ctx)}
             ORDER BY t.performed_at DESC
             LIMIT ${rowLimit(ctx)}
        `);
        // ID 166: never the stored or provider link itself — a checked CRM link.
        const origin = exportOrigin();
        return [
            {
                ...this.sheets[0],
                rows: data.map(({ ai_call_id, recording_url, ...r }) => ({ ...r, recording_url: recordingCell(recording_url, ai_call_id, origin) })),
            },
        ];
    },
};

// ────────────────────────────────── Visits ──────────────────────────────────

function visitsWhere(ctx: RunContext): SQL {
    const day = ctx.params.get("date_field") === "planned" ? sql`v.scheduled_date` : sql`COALESCE(v.actual_visit_date, v.scheduled_date)`;
    const conds: SQL[] = [dayRange(ctx.params, day)];
    if (ctx.ownOnly) conds.push(ownRows(ctx, sql`v.asm_id`));
    const status = ctx.params.get("status");
    if (status) conds.push(sql`lower(v.visit_status) = ${status.toLowerCase()}`);
    const outcome = ctx.params.get("outcome");
    if (outcome) conds.push(sql`lower(v.visit_outcome) = ${outcome.toLowerCase()}`);
    conds.push(...commonConds(ctx, { person: sql`v.asm_id`, leadId: sql`v.dealer_lead_id` }));
    return sql.join(conds, sql` AND `);
}

const visits: Dataset = {
    id: "visits",
    label: "Visits",
    description: "One row per ASM visit on a dealer lead, planned or done.",
    roles: MANAGERS,
    ownRowsRoles: ["asm"],
    dateFields: [
        { value: "visit", label: "Visit date" },
        { value: "planned", label: "Planned for" },
    ],
    commonFilters: ["person", "state"],
    background: true,
    filters: [
        { key: "status", label: "Status (e.g. visited, scheduled)", type: "text" },
        { key: "outcome", label: "Outcome", type: "text" },
    ],
    sheets: [
        {
            name: "Visits",
            columns: [
                { key: "visit_date", header: "Visit date", meaning: "The actual visit date, else the planned one.", kind: "date" },
                { key: "scheduled_date", header: "Planned for", meaning: "The date the visit was scheduled for.", kind: "date" },
                { key: "lead_id", header: "Lead ID", meaning: "The lead visited.", width: 24 },
                { key: "dealer", header: "Dealer", meaning: "Dealer or shop name on the lead.", width: 28 },
                { key: "city", header: "City", meaning: "Lead's city." },
                { key: "state", header: "State", meaning: "Lead's state." },
                { key: "visitor", header: "ASM", meaning: "The ASM on the visit.", width: 22 },
                { key: "meeting_mode", header: "Mode", meaning: "Ground, calling or WhatsApp." },
                { key: "visit_status", header: "Status", meaning: "Scheduled, visited, and so on." },
                { key: "visit_outcome", header: "Outcome", meaning: "The visit outcome logged.", width: 24 },
                // ID 185 — the shared Fresh / Repeat rule (src/lib/visits/freshRepeat.ts), visited rows only.
                { key: "new_visit", header: "First visit", meaning: "New to iTarang: Yes when this is the dealer's first visit by anyone (status visited); No for a later one. Blank when the row is not a visit (scheduled, cancelled, no-show)." },
                { key: "fresh_for_rep", header: "Fresh for this rep", meaning: "Yes when this is this person's first visit to the dealer (a dealer new to iTarang is also fresh); No = a repeat visit by the same person. Blank when the row is not a visit." },
                { key: "visit_remarks", header: "Remarks", meaning: "What the ASM wrote.", width: 50 },
                { key: "next_visit_date", header: "Next visit", meaning: "The next visit date set on this visit.", kind: "date" },
                { key: "photos", header: "Photos", meaning: "Number of photos attached.", kind: "number" },
                { key: "location_pin", header: "Location pin", meaning: "Latitude, longitude captured at check-in. Blank = none captured.", width: 24 },
                { key: "transferred_on", header: "Transferred on", meaning: "When the lead was last handed to an ASM.", kind: "datetime" },
                { key: "transferred_by", header: "Transferred by", meaning: "Who handed it over.", width: 22 },
                { key: "owner_at_transfer", header: "Lead owner at transfer", meaning: "ID 179: who owned the lead when it was handed over — the person 'Hot to field' is credited to (Transferred by, on old rows that did not record it). Blank = nobody owned it (a bulk assign of an unowned lead), so no one is credited.", width: 22 },
                { key: "days_transfer_to_visit", header: "Working days from transfer to visit", meaning: "Working days (office calendar, holidays off) after the day of that transfer up to the visit day. Blank when the visit is not done or came before the transfer.", kind: "number" },
                { key: "transfer_visit_within_limit", header: "Visit within the field-visit limit", meaning: "Yes when those working days are within the first-visit limit in force on the transfer day (Admin › Time limits); No when past it. Blank when the visit is not done or came before the transfer." },
                // IDs 85 / 86 — the field-visit (transfer) clock covering this visit.
                { key: "visit_limit_days", header: "Field-visit limit (working days)", meaning: "Transfer clock (ID 86): the first-visit limit in force on the day of the transfer this visit answers. Blank = no transfer clock.", kind: "number" },
                { key: "visit_limit_passed", header: "Field-visit limit passed", meaning: "No, or Yes with when (IST): the first visit after that transfer came after the limit, or has not come. Blank = no transfer clock." , width: 22 },
                // ID A18 — lead-by-lead review: where the lead stands now.
                { key: "lead_status_now", header: "Lead status now", meaning: "The lead's status today (A18: review each visited lead and what happened next)." },
                { key: "interest_now", header: "Interest now", meaning: "Hot / Warm / Cold today." },
                { key: "next_follow_up", header: "Next follow-up", meaning: "The lead's next follow-up date, if one is set.", kind: "datetime" },
                { key: "last_disposition", header: "Last call outcome", meaning: "The latest call disposition on the lead.", width: 24 },
                { key: "owner_now", header: "Owner now", meaning: "Who holds the lead today.", width: 22 },
            ],
        },
    ],
    async count(ctx) {
        const [r] = await rows<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM lead_visits v WHERE ${visitsWhere(ctx)}`);
        return Number(r?.n ?? 0);
    },
    async build(ctx) {
        // IDs 85 / 86 — the transfer clock this visit answers (latest started
        // on or before the visit day), when E-337's lead_clocks exists.
        const clocks = await hasLeadClocks();
        const clockJoin = clocks
            ? sql`LEFT JOIN LATERAL (
                  SELECT c.limit_value, c.limit_passed_at FROM lead_clocks c
                   WHERE c.dealer_lead_id = v.dealer_lead_id AND c.clock = 'transfer'
                     AND (c.started_at AT TIME ZONE 'Asia/Kolkata')::date <= COALESCE(v.actual_visit_date, v.scheduled_date, CURRENT_DATE)
                   ORDER BY c.started_at DESC LIMIT 1) tc ON TRUE`
            : sql``;
        const clockCols = clocks
            ? sql`tc.limit_value::int AS visit_limit_days,
                   CASE WHEN tc.limit_value IS NULL THEN NULL
                        WHEN tc.limit_passed_at IS NULL THEN 'No'
                        ELSE 'Yes · ' || to_char(tc.limit_passed_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') END AS visit_limit_passed`
            : sql`NULL::int AS visit_limit_days, NULL::text AS visit_limit_passed`;
        // 18 Oct row 37 — working days on the office calendar, judged by the
        // limit in force on the transfer's day.
        // ID 85 #6: the holidays as they stood on the visit day.
        await primeHolidayLog();
        const transferToVisitDays = workingDaysBetweenAsOfSql(sql`tr.performed_at`, sql`((v.actual_visit_date + TIME '10:00') AT TIME ZONE 'Asia/Kolkata')`);
        const visitLimitOnTransferDay = (await limitOnDay("asm_transfer_first_visit"))(sql`(tr.performed_at AT TIME ZONE 'Asia/Kolkata')::date`);
        const data = await rows(sql`
            SELECT COALESCE(v.actual_visit_date, v.scheduled_date) AS visit_date, v.scheduled_date,
                   v.dealer_lead_id AS lead_id,
                   COALESCE(dl.dealer_name, dl.shop_name) AS dealer, dl.city, dl.state,
                   u.name AS visitor, v.meeting_mode, v.visit_status, v.visit_outcome,
                   CASE WHEN ${visitedRowSql("v")} THEN ${isNewToItarangSql("v")} END AS new_visit,
                   CASE WHEN ${visitedRowSql("v")} THEN ${isFreshSql("v")} END AS fresh_for_rep,
                   v.visit_remarks, v.next_visit_date,
                   CASE WHEN jsonb_typeof(v.photos) = 'array' THEN jsonb_array_length(v.photos) ELSE 0 END AS photos,
                   CASE WHEN v.gps_check_in_lat IS NOT NULL AND v.gps_check_in_lng IS NOT NULL
                        THEN v.gps_check_in_lat::text || ', ' || v.gps_check_in_lng::text END AS location_pin,
                   tr.performed_at AS transferred_on, tr.name AS transferred_by, tr.owner_name AS owner_at_transfer,
                   CASE WHEN v.actual_visit_date >= (tr.performed_at AT TIME ZONE 'Asia/Kolkata')::date
                        THEN ${transferToVisitDays} END AS days_transfer_to_visit,
                   CASE WHEN v.actual_visit_date >= (tr.performed_at AT TIME ZONE 'Asia/Kolkata')::date
                        THEN CASE WHEN ${transferToVisitDays} <= ${visitLimitOnTransferDay} THEN 'Yes' ELSE 'No' END END AS transfer_visit_within_limit,
                   ${clockCols},
                   replace(dl.lead_status, '_', ' ') AS lead_status_now, dl.interest_level AS interest_now,
                   dl.next_follow_up_at AS next_follow_up, dl.last_disposition, ou.name AS owner_now
              FROM lead_visits v
              LEFT JOIN dealer_leads dl ON dl.id = v.dealer_lead_id
              LEFT JOIN users u ON u.id::text = v.asm_id
              LEFT JOIN users ou ON ou.id::text = dl.current_owner_id
              ${freshRepeatJoins("v", true)}
              ${clockJoin}
              LEFT JOIN LATERAL (
                  -- HANDOVER-A31: the transferCredit() rule — no previous owner on a recorded move = nobody.
                  SELECT tt.performed_at, tu.name, COALESCE(fo.name, CASE WHEN tt.to_owner_id IS NULL THEN tu.name END) AS owner_name FROM lead_touchpoints tt
                    LEFT JOIN users tu ON tu.id::text = tt.performed_by
                    LEFT JOIN users fo ON fo.id::text = tt.from_owner_id
                   WHERE tt.dealer_lead_id = v.dealer_lead_id AND tt.touchpoint_type = 'asm_transfer'
                   ORDER BY tt.performed_at DESC LIMIT 1) tr ON TRUE
             WHERE ${visitsWhere(ctx)}
             ORDER BY visit_date DESC NULLS LAST
             LIMIT ${rowLimit(ctx)}
        `);
        return [{ ...this.sheets[0], rows: data }];
    },
};

// ────────────────────────────────── Quotes ──────────────────────────────────

/**
 * ID 146 — one quote line's frozen list price (`pl` = a product_lines element
 * of `c`): the line's own list_price, else the retired list_price_snapshot
 * (read through to_jsonb, so a database without that column reads null).
 */
const QUOTE_LINE_LIST_PRICE = sql`COALESCE(
    ${jnum(sql`pl ->> 'list_price'`)},
    (SELECT ${jnum(sql`lp ->> 'list_price'`)}
       FROM jsonb_array_elements(${jarr(sql`(to_jsonb(c) -> 'list_price_snapshot') -> 'lines'`)}) lp
      WHERE lp ->> 'product_id' = pl ->> 'product_id' LIMIT 1))`;

const quoteFrom = sql`
      FROM dealer_lead_commercials c
      LEFT JOIN dealer_leads dl ON dl.id = c.dealer_lead_id
      LEFT JOIN users cu ON cu.id::text = c.created_by
      LEFT JOIN users au ON au.id::text = c.approved_by
      LEFT JOIN LATERAL (
          SELECT MIN(x.created_at) AS delivered_at, string_agg(DISTINCT x.channel, ', ') AS channels
            FROM quotation_dispatches x WHERE x.commercial_id = c.commercial_id AND x.status = 'sent'
      ) qd ON TRUE
      LEFT JOIN LATERAL (
          -- ID 146: the list price is frozen on each quote line
          -- (product_lines[].list_price, listPrices.ts snapshotListPrices, E-321).
          -- The retired second build's list_price_snapshot column is only a
          -- fallback for the few db-1 rows it wrote on 3-5 Oct; nothing fills
          -- it now, which is why List price / Discount came out blank.
          -- Discount compares only the lines that carry a list price.
          SELECT SUM(${QUOTE_LINE_LIST_PRICE} * ${jnum(sql`pl ->> 'quantity'`)}) AS list_total,
                 SUM(${jnum(sql`pl ->> 'unit_price'`)} * ${jnum(sql`pl ->> 'quantity'`)})
                     FILTER (WHERE ${QUOTE_LINE_LIST_PRICE} IS NOT NULL) AS quoted_listed_total
            FROM jsonb_array_elements(${jarr(sql`c.product_lines`)}) pl
      ) lt ON TRUE
      LEFT JOIN LATERAL (
          SELECT MIN(${jnum(sql`ol ->> 'delta'`)}) AS min_delta
            FROM jsonb_array_elements(${jarr(sql`c.oem_evaluation -> 'lines'`)}) ol
      ) oe ON TRUE
`;

const QUOTE_DATES: Record<string, SQL> = {
    created: sql`c.created_at`,
    delivered: sql`qd.delivered_at`,
    answered: sql`c.dealer_decision_at`,
};

function quotesWhere(ctx: RunContext): SQL {
    const expr = QUOTE_DATES[ctx.params.get("date_field") ?? "created"] ?? QUOTE_DATES.created;
    const conds: SQL[] = [sql`c.event_type IN ('quote_issue', 'quote_revision')`, dateRange(ctx.params, expr)];
    if (ctx.ownOnly) conds.push(ownRows(ctx, sql`c.created_by`));
    const approval = ctx.params.get("approval");
    if (approval) conds.push(sql`c.approval_status = ${approval}`);
    const answer = ctx.params.get("dealer_answer");
    if (answer === "none") conds.push(sql`c.dealer_decision IS NULL`);
    else if (answer) conds.push(sql`c.dealer_decision = ${answer}`);
    if (ctx.params.get("current") === "1") conds.push(sql`c.is_current IS TRUE`);
    conds.push(...commonConds(ctx, { person: sql`c.created_by`, state: sql`dl.state` }));
    return sql.join(conds, sql` AND `);
}

const quotes: Dataset = {
    id: "quotes",
    label: "Quotes",
    description: "One row per quote version on a dealer lead, with its approval, delivery and the dealer's answer. Product lines are on their own sheet.",
    roles: MANAGERS,
    ownRowsRoles: ["asm", "inside_sales_rep"],
    dateFields: [
        { value: "created", label: "Created" },
        { value: "delivered", label: "Delivered" },
        { value: "answered", label: "Dealer answered" },
    ],
    commonFilters: ["team", "person", "state"],
    background: true,
    filters: [
        { key: "approval", label: "Approval", type: "select", options: ["pending", "approved", "rejected"].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })) },
        { key: "dealer_answer", label: "Dealer answer", type: "select", options: [{ value: "approved", label: "Approved" }, { value: "declined", label: "Declined" }, { value: "none", label: "No answer yet" }] },
        { key: "current", label: "Current versions only", type: "select", options: yesNo },
    ],
    sheets: [
        {
            name: "Quotes",
            columns: [
                { key: "quote_number", header: "Quote no.", meaning: "The number on the generated quotation; blank until one is generated." },
                { key: "version_no", header: "Version", meaning: "Version of the quote on this lead.", kind: "number" },
                { key: "is_current", header: "Current version", meaning: "Yes on the lead's latest version." },
                { key: "lead_id", header: "Lead ID", meaning: "The lead quoted.", width: 24 },
                { key: "dealer", header: "Dealer", meaning: "Dealer or shop name on the lead.", width: 28 },
                { key: "created_by", header: "Created by", meaning: "Who raised the quote.", width: 22 },
                { key: "created_at", header: "Created on", meaning: "When the quote was raised.", kind: "datetime" },
                { key: "price_quoted", header: "Quoted (₹)", meaning: "The price quoted on this version.", kind: "money" },
                { key: "final_price", header: "Final price (₹)", meaning: "The final price, when one was recorded.", kind: "money" },
                { key: "sub_total", header: "Before GST (₹)", meaning: "From the generated quotation; blank until the quote is approved and its PDF generated.", kind: "money" },
                { key: "gst", header: "GST (₹)", meaning: "Total with GST minus the amount before GST, from the generated quotation.", kind: "money" },
                { key: "total_with_gst", header: "Total with GST (₹)", meaning: "From the generated quotation.", kind: "money" },
                { key: "list_total", header: "List price total (₹)", meaning: "Quantity × list price over the lines, at the list prices frozen on the quote. Blank on quotes raised before list prices existed.", kind: "money" },
                { key: "discount", header: "Discount on list (₹)", meaning: "List price total minus the quoted total, over the lines that carry a list price.", kind: "money" },
                { key: "lowest_vs_oem", header: "Lowest line vs OEM price (₹)", meaning: "The smallest gap between a line's quoted unit price and its OEM price; negative = quoted below OEM price.", kind: "money" },
                { key: "onboarding_fee", header: "Onboarding fee (₹)", meaning: "Deal card (ID 172): the onboarding fee agreed on this quote; 0 = waived; blank = not asked (the dealer was already onboarded, so ISR, ASM and Sales Head may skip it, ID 186), or a quote from before the deal card. Prints on the dealer's quotation.", kind: "money" },
                { key: "fee_waived_reason", header: "Why waived", meaning: "Deal card: why the onboarding fee is 0.", width: 28 },
                { key: "expected_batteries_per_month", header: "Expected batteries per month", meaning: "Deal card: batteries the dealer said they will buy from us a month after the first order. Internal. Blank = not asked (dealer already onboarded; ISR, ASM and Sales Head may skip it, ID 186).", kind: "number" },
                { key: "expected_finance_files_per_month", header: "Expected finance files per month", meaning: "Deal card: of the dealer's monthly customers, how many buy on a loan. Internal; replaced Customer finance Yes / No. Blank = not asked (dealer already onboarded, ID 186).", kind: "number" },
                { key: "fee_invoiced", header: "Fee invoiced (₹)", meaning: "Onboarding fee actually invoiced to this dealer (before GST): invoice lines mapped 'Onboarding fee' in Invoice Ledger › Item mapping. Same for every version of the lead.", kind: "money" },
                { key: "batteries_60d_after_won", header: "Batteries ordered in the 60 days after Won", meaning: "Battery units invoiced to this dealer in the 60 days from the day the lead was marked Won (invoice lines, HSN 8507). Blank when the lead was never Won.", kind: "number" },
                { key: "credit_terms", header: "Credit terms", meaning: "Credit terms written on the quote.", width: 24 },
                { key: "payment_method", header: "Payment method", meaning: "Payment method on the quote." },
                { key: "approval_status", header: "Approval", meaning: "iTarang's own approval: pending, approved or rejected." },
                { key: "approval_mode", header: "Approved how", meaning: "'auto' = passed the OEM price check; 'manual' = a person decided." },
                { key: "approved_by", header: "Approver", meaning: "Who approved or rejected it.", width: 22 },
                { key: "approved_at", header: "Decided on", meaning: "When it was approved or rejected.", kind: "datetime" },
                { key: "approval_wait_hours", header: "Approval wait (hours)", meaning: "Hours from raising the quote to the decision.", kind: "number" },
                // IDs 85 / 86 — the CEO quote-approval clock (E-350).
                { key: "approval_working_hours", header: "Approval wait (working hours)", meaning: "CEO quote-approval clock: working hours (office hours in Admin › Time limits, holidays off) from the quote reaching the CEO to the decision. Blank for auto-approved quotes and before E-350.", kind: "number" },
                { key: "approval_limit_passed", header: "Approval limit passed", meaning: "No, or Yes with when (IST): the CEO decided after the limit (Admin › Time limits), or has not decided. Blank for auto-approved quotes.", width: 22 },
                { key: "rejection_reason", header: "Rejection reason", meaning: "Why it was rejected, when it was.", width: 36 },
                { key: "delivered_at", header: "Delivered on", meaning: "First successful send of the quotation to the dealer.", kind: "datetime" },
                { key: "channels", header: "Delivered through", meaning: "Email, WhatsApp, or both." },
                { key: "dealer_decision", header: "Dealer answer", meaning: "What the dealer said: approved or declined. Blank = no answer yet." },
                { key: "dealer_decision_at", header: "Dealer answered on", meaning: "When the dealer answered.", kind: "datetime" },
                { key: "dealer_decision_via", header: "Answered through", meaning: "How the answer reached us." },
                { key: "withdrawn_at", header: "Withdrawn on", meaning: "When the quote was withdrawn, if it was.", kind: "datetime" },
                { key: "withdraw_reason", header: "Withdrawal reason", meaning: "Why it was withdrawn.", width: 30 },
                // 18 Oct row 38 — the waits after approval, each against its limit (Admin › Time limits).
                { key: "approved_to_delivered_wh", header: "Approved → delivered (working hours)", meaning: "Clock 'Approved quote not delivered': working hours from the approval to the first successful send. Blank when not approved, not yet sent, or approved before sends were recorded.", kind: "number" },
                { key: "delivery_limit_passed", header: "Delivery limit passed", meaning: "No, or Yes with when (IST): the quotation was not sent by the 'Approved quote: sent to the dealer' limit (default the same working day). Blank = not timed.", width: 22 },
                { key: "delivered_to_answer_wd", header: "Delivered → dealer answer (working days)", meaning: "Working days after the day of the first send up to the dealer's answer — or up to today when there is no answer yet. Blank when not delivered.", kind: "number" },
                { key: "answer_limit_passed", header: "Answer limit passed", meaning: "Yes when those working days are past 'Quote sent, no answer from the dealer' in force on the delivery day; else No. Blank when not delivered.", width: 18 },
                { key: "dealer_yes_to_won_wd", header: "Dealer approved → Won (working days)", meaning: "Working days after the day the dealer approved up to the lead marked Won — or up to today when it is not Won yet. Blank unless the dealer approved.", kind: "number" },
                { key: "won_limit_passed", header: "Won limit passed", meaning: "Yes when those working days are past 'Dealer said yes, lead not marked Won' in force on the day the dealer approved; else No.", width: 18 },
                { key: "declined_to_revised_wd", header: "Declined → revised or Lost (working days)", meaning: "Clock 'Dealer declined, not revised or marked Lost': working days after the day of the decline up to a newer quote version or the lead marked Lost — or up to today when neither came. Blank unless the dealer declined.", kind: "number" },
                { key: "revise_limit_passed", header: "Revise limit passed", meaning: "No, or Yes with when (IST): no newer version and not Lost within 'Dealer declined a quote: revised or marked Lost'. Blank unless declined (or before the clock exists on this server).", width: 22 },
            ],
        },
        {
            name: "Lines",
            columns: [
                { key: "quote_number", header: "Quote no.", meaning: "The quote the line belongs to." },
                { key: "lead_id", header: "Lead ID", meaning: "The lead quoted.", width: 24 },
                { key: "version_no", header: "Version", meaning: "Quote version.", kind: "number" },
                { key: "product_name", header: "Product", meaning: "Product on the line.", width: 30 },
                { key: "asset_type", header: "Asset type", meaning: "Battery, charger, and so on." },
                { key: "quantity", header: "Quantity", meaning: "Units quoted.", kind: "number" },
                { key: "unit_price", header: "Unit price (₹)", meaning: "Price per unit quoted.", kind: "money" },
                { key: "list_price", header: "List price (₹)", meaning: "The list price frozen on the quote for this product.", kind: "money" },
                { key: "oem_price", header: "OEM price (₹)", meaning: "The OEM price the quote was checked against.", kind: "money" },
            ],
        },
    ],
    async count(ctx) {
        const [r] = await rows<{ n: number }>(sql`SELECT COUNT(*)::int AS n ${quoteFrom} WHERE ${quotesWhere(ctx)}`);
        return Number(r?.n ?? 0);
    },
    async build(ctx) {
        // ID 172: deal card (E-336 via to_jsonb) + what was invoiced against it.
        const actuals = await dealCardActualsSql();
        const actualsJoin = actuals ? sql`LEFT JOIN (${actuals}) da ON da.lead_id = c.dealer_lead_id` : sql``;
        const actualCols = actuals
            ? sql`da.fee_invoiced, CASE WHEN (to_jsonb(dl) ->> 'won_at') IS NOT NULL THEN COALESCE(da.batteries_60d, 0) END AS batteries_60d_after_won`
            : sql`NULL::float8 AS fee_invoiced, NULL::float8 AS batteries_60d_after_won`;
        // IDs 85 / 86 — the CEO quote-approval clock for this version.
        const clocks = await hasLeadClocks();
        const qcJoin = clocks
            ? sql`LEFT JOIN lead_clocks qc ON qc.dealer_lead_id = c.dealer_lead_id AND qc.clock = 'quote' AND qc.started_at = date_trunc('milliseconds', c.created_at)`
            : sql``;
        const qcCols = clocks
            ? sql`ROUND((qc.attempt_working_minutes / 60.0)::numeric, 1) AS approval_working_hours,
                   CASE WHEN qc.limit_value IS NULL THEN NULL
                        WHEN qc.limit_passed_at IS NULL THEN 'No'
                        ELSE 'Yes · ' || to_char(qc.limit_passed_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') END AS approval_limit_passed`
            : sql`NULL::numeric AS approval_working_hours, NULL::text AS approval_limit_passed`;
        // 18 Oct row 38 — the delivery and decline clocks (E-355), and the two
        // waits judged in SQL on the office calendar by the limit of their day.
        const tl = await hasTimeLimitTable();
        // ID 85 #6: a wait that ended is counted with the holidays as they stood then.
        await primeHolidayLog();
        const passedText = (alias: string) =>
            sql.raw(`CASE WHEN ${alias}.limit_value IS NULL THEN NULL WHEN ${alias}.limit_passed_at IS NULL THEN 'No'
                     ELSE 'Yes · ' || to_char(${alias}.limit_passed_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') END`);
        const waitJoin = clocks
            ? sql`LEFT JOIN lead_clocks qdc ON qdc.dealer_lead_id = c.dealer_lead_id AND qdc.clock = 'quote_deliver'
                       AND qdc.started_at = date_trunc('milliseconds', COALESCE(c.approved_at, c.created_at))
                  LEFT JOIN lead_clocks qrc ON qrc.dealer_lead_id = c.dealer_lead_id AND qrc.clock = 'quote_revise'
                       AND qrc.started_at = date_trunc('milliseconds', c.dealer_decision_at)`
            : sql``;
        const wonAt = sql`(to_jsonb(dl) ->> 'won_at')::timestamptz`;
        const answerDays = workingDaysBetweenAsOfSql(sql`qd.delivered_at`, sql`COALESCE(c.dealer_decision_at, NOW())`);
        const wonDays = workingDaysBetweenAsOfSql(sql`c.dealer_decision_at`, sql`COALESCE(${wonAt}, NOW())`);
        const waitCols = sql`
                   CASE WHEN qd.delivered_at IS NOT NULL THEN ${answerDays} END AS delivered_to_answer_wd,
                   CASE WHEN qd.delivered_at IS NOT NULL THEN
                        CASE WHEN ${answerDays} > ${limitOnDaySql("quote_no_answer", sql`(qd.delivered_at AT TIME ZONE 'Asia/Kolkata')::date`, tl)} THEN 'Yes' ELSE 'No' END END AS answer_limit_passed,
                   CASE WHEN c.dealer_decision = 'approved' AND c.dealer_decision_at IS NOT NULL THEN ${wonDays} END AS dealer_yes_to_won_wd,
                   CASE WHEN c.dealer_decision = 'approved' AND c.dealer_decision_at IS NOT NULL THEN
                        CASE WHEN ${wonDays} > ${limitOnDaySql("said_yes_not_won", sql`(c.dealer_decision_at AT TIME ZONE 'Asia/Kolkata')::date`, tl)} THEN 'Yes' ELSE 'No' END END AS won_limit_passed,
                   ${clocks
                       ? sql`ROUND((qdc.attempt_working_minutes / 60.0)::numeric, 1) AS approved_to_delivered_wh,
                   ${passedText("qdc")} AS delivery_limit_passed,
                   CASE WHEN c.dealer_decision = 'declined' AND c.dealer_decision_at IS NOT NULL
                        THEN ${workingDaysBetweenAsOfSql(sql`c.dealer_decision_at`, sql`COALESCE(qrc.first_attempt_at, NOW())`)} END AS declined_to_revised_wd,
                   ${passedText("qrc")} AS revise_limit_passed`
                       : sql`NULL::numeric AS approved_to_delivered_wh, NULL::text AS delivery_limit_passed,
                   NULL::int AS declined_to_revised_wd, NULL::text AS revise_limit_passed`}`;
        const [quoteRows, lineRows] = await Promise.all([
            rows(sql`
                SELECT c.quote_number, c.version_no, c.is_current, c.dealer_lead_id AS lead_id,
                       COALESCE(dl.dealer_name, dl.shop_name) AS dealer,
                       COALESCE(cu.name, c.created_by) AS created_by, c.created_at,
                       c.price_quoted, c.final_price,
                       ${jnum(sql`c.quote_snapshot ->> 'subTotal'`)} AS sub_total,
                       ${jnum(sql`c.quote_snapshot ->> 'total'`)} - ${jnum(sql`c.quote_snapshot ->> 'subTotal'`)} AS gst,
                       ${jnum(sql`c.quote_snapshot ->> 'total'`)} AS total_with_gst,
                       lt.list_total AS list_total,
                       lt.list_total - lt.quoted_listed_total AS discount,
                       oe.min_delta AS lowest_vs_oem,
                       c.credit_terms, c.payment_method,
                       c.approval_status, c.approval_mode, au.name AS approved_by, c.approved_at,
                       ROUND((EXTRACT(EPOCH FROM (c.approved_at - c.created_at)) / 3600)::numeric, 1) AS approval_wait_hours,
                       c.rejection_reason, qd.delivered_at, qd.channels,
                       c.dealer_decision, c.dealer_decision_at, c.dealer_decision_via, c.withdrawn_at,
                       to_jsonb(c) ->> 'withdraw_reason' AS withdraw_reason,
                       (to_jsonb(c) ->> 'onboarding_fee')::numeric AS onboarding_fee,
                       to_jsonb(c) ->> 'fee_waived_reason' AS fee_waived_reason,
                       (to_jsonb(c) ->> 'expected_batteries_per_month')::int AS expected_batteries_per_month,
                       (to_jsonb(c) ->> 'expected_finance_files_per_month')::int AS expected_finance_files_per_month,
                       ${actualCols},
                       ${qcCols},
                       ${waitCols}
                  ${quoteFrom}
                  ${actualsJoin}
                  ${qcJoin}
                  ${waitJoin}
                 WHERE ${quotesWhere(ctx)}
                 ORDER BY c.created_at DESC
                 LIMIT ${rowLimit(ctx)}
            `),
            rows(sql`
                SELECT c.quote_number, c.dealer_lead_id AS lead_id, c.version_no,
                       pl ->> 'product_name' AS product_name, pl ->> 'asset_type' AS asset_type,
                       pl ->> 'quantity' AS quantity, pl ->> 'unit_price' AS unit_price,
                       ${QUOTE_LINE_LIST_PRICE} AS list_price,
                       (SELECT ol ->> 'oem_price' FROM jsonb_array_elements(${jarr(sql`c.oem_evaluation -> 'lines'`)}) ol
                         WHERE ol ->> 'product_id' = pl ->> 'product_id' LIMIT 1) AS oem_price
                  ${quoteFrom}
                 CROSS JOIN LATERAL jsonb_array_elements(
                     CASE WHEN jsonb_typeof(c.product_lines) = 'array' THEN c.product_lines ELSE '[]'::jsonb END) pl
                 WHERE ${quotesWhere(ctx)}
                 ORDER BY c.created_at DESC
            `),
        ]);
        return [
            { ...this.sheets[0], rows: quoteRows },
            { ...this.sheets[1], rows: lineRows },
        ];
    },
};

// ──────────────────────────── Targets and actuals ───────────────────────────

/** `month` filter as YYYY-MM; blank or malformed = the current IST month. */
async function targetMonth(params: URLSearchParams): Promise<string> {
    const m = params.get("month") ?? "";
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return m;
    const [d] = await rows<{ m: string }>(sql`SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS m`);
    return d.m;
}

const targets: Dataset = {
    id: "targets",
    label: "Targets and actuals",
    description: "One row per person, metric and month: the target, its status, and progress to date. One month per file.",
    roles: MANAGERS,
    ownRowsRoles: ["asm", "inside_sales_rep"],
    dateFields: [],
    commonFilters: ["team", "person"],
    filters: [
        { key: "month", label: "Month (YYYY-MM; blank = this month)", type: "text" },
        { key: "status", label: "Target status", type: "select", options: TARGET_STATUSES.filter((s) => s !== "rejected").map((s) => ({ value: s, label: TARGET_STATUS_LABEL[s] })) },
    ],
    sheets: [
        {
            name: "Targets and actuals",
            columns: [
                { key: "month", header: "Month", meaning: "First day of the target month.", kind: "date" },
                { key: "user_name", header: "Person", meaning: "Whose target it is.", width: 22 },
                { key: "user_role", header: "Role", meaning: "That person's role." },
                { key: "metric_label", header: "Metric", meaning: "What is being targeted.", width: 30 },
                { key: "ceo_target", header: "CEO target", meaning: "The CEO target in force (the version the person was sent).", kind: "number" },
                { key: "stretch", header: "Stretch", meaning: "ID 189: what the Sales Head added on top of the CEO target (never below 0).", kind: "number" },
                { key: "final_target", header: "Final target", meaning: "CEO target + stretch, the version in force.", kind: "number" },
                { key: "stretch_note", header: "Stretch note", meaning: "The Sales Head's optional note on the stretch.", width: 30 },
                { key: "version", header: "Version", meaning: "The version in force (0 = never posted by the CEO).", kind: "number" },
                { key: "posted_at", header: "Posted on", meaning: "When the CEO last posted it to the Sales Head.", kind: "datetime" },
                { key: "waiting_push", header: "Change waiting to push", meaning: "Yes = a posted change (or first post) the Sales Head has not pushed yet; the numbers above stay in force until then." },
                { key: "status", header: "Status", meaning: "Draft (CEO only), posted (with the Sales Head), sent, accepted; 'rejected' only on old rows." },
                { key: "pushed_at", header: "Pushed on", meaning: "When the latest version was pushed to the person (the date it arrived).", kind: "datetime" },
                { key: "first_pushed_at", header: "First pushed on", meaning: "The first push: the 48-hour acceptance clock runs from here.", kind: "datetime" },
                { key: "accepted_at", header: "Accepted on", meaning: "When the person accepted it.", kind: "datetime" },
                { key: "accept_remark", header: "Accept remark", meaning: "The person's optional remark on accepting.", width: 30 },
                { key: "correction_requested_at", header: "Correction asked on", meaning: "When the person last asked for a correction.", kind: "datetime" },
                { key: "correction_remark", header: "Correction remark", meaning: "What the person asked to correct.", width: 30 },
                { key: "reject_comment", header: "Reject comment (old flow)", meaning: "Only on targets rejected before 16 Oct 2026.", width: 30 },
                { key: "unit", header: "Unit", meaning: "A custom metric's unit; blank for built-in metrics." },
                { key: "is_custom", header: "Custom metric", meaning: "Yes = progress is typed in by hand." },
                { key: "mtd_target", header: "Target to date", meaning: "The share of the target due by today, by working days.", kind: "number" },
                { key: "actual", header: "Actual to date", meaning: "Month-to-date actual, counted the same way as the Sales dashboard. Blank = not measured (see the next column).", kind: "number" },
                { key: "not_measured_reason", header: "Why not measured", meaning: "Why the actual is blank, in words.", width: 30 },
                { key: "pct_of_mtd", header: "% of target to date", meaning: "Actual ÷ target to date.", kind: "number" },
                { key: "remaining", header: "Remaining", meaning: "Final target minus actual.", kind: "number" },
                { key: "required_per_day", header: "Needed per remaining day", meaning: "Remaining ÷ working days left in the month.", kind: "number" },
            ],
        },
    ],
    async count(ctx) {
        const month = await targetMonth(ctx.params);
        const status = ctx.params.get("status");
        const [r] = await rows<{ n: number }>(sql`
            SELECT COUNT(*)::int AS n FROM sales_targets t
             WHERE t.month = ${`${month}-01`}::date
               -- The rows listTargets() returns: built-in metrics and named custom ones.
               AND (t.metric IN (${sql.join(TARGET_METRIC_KEYS.map((m) => sql`${m}`), sql`, `)})
                    OR (left(t.metric, 7) = 'custom_' AND (to_jsonb(t) ->> 'custom_label') IS NOT NULL))
               ${ctx.ownOnly ? sql`AND ${ownRows(ctx, sql`t.user_id`)}` : sql``}
               -- ID 189: the CEO's unposted drafts are his alone; the rep's own
               -- download only what was pushed to them; never a removed row.
               AND ${targetVisibleSql(ctx.ownOnly ? "member" : targetViewerFor(ctx.user.role))}
               ${status ? sql`AND t.status = ${status}` : sql``}
               ${sql.join(commonConds(ctx, { person: sql`t.user_id` }).map((c) => sql`AND ${c}`), sql` `)}
        `);
        return Number(r?.n ?? 0);
    },
    async build(ctx) {
        const month = await targetMonth(ctx.params);
        const status = ctx.params.get("status");
        const role = teamRole(ctx);
        // ID 155: a manager's own-rows download lists his team's targets too.
        const team = ctx.ownOnly && ctx.teamIds?.length ? new Set([ctx.user.id, ...ctx.teamIds]) : null;
        const list = (
            await listTargets({
                month,
                userId: ctx.ownOnly ? (team ? undefined : ctx.user.id) : (personParam(ctx) ?? undefined),
                viewer: ctx.ownOnly ? "member" : targetViewerFor(ctx.user.role),
            })
        ).filter(
            (t) => (!role || t.user_role === role) && (!team || team.has(t.user_id)),
        );
        return [
            {
                ...this.sheets[0],
                rows: list
                    .filter((t) => !status || t.status === status)
                    // ceo_progress rides along unused: only the columns above are written.
                    .map(({ progress, ...t }) => ({
                        ...t,
                        ...progress,
                        waiting_push: t.waiting_push ? "Yes" : "",
                        is_custom: t.is_custom ? "Yes" : "",
                        user_role: (t.user_role ?? "").replace(/_/g, " ") || null,
                    })),
            },
        ];
    },
};

// ───────────────────────────────── Invoices ─────────────────────────────────

// ID 71: 'credit_note' = a non-void credit note (revenueSource.ts, source 'credit').
const INVOICE_STATUSES = ["draft", "sent", "overdue", "paid", "partially_paid", "void", "credit_note"];
const INVOICE_SOURCES = ["drive", "zoho", "credit"];

/**
 * The unioned invoices with their own table's extra columns, the dealer account
 * and its owner — today and on the invoice date.
 *
 * ID 146: everything comes from matchedUnion() (revenueSource.ts), the same
 * match the Sales invoices page and the dashboards use. It already resolves
 * the account (hand link, account GSTIN or alias) as r.account_id and, for an
 * account match, the owner whose account_owner_history window holds the
 * invoice date as r.dealer_owner_id. The download used to redo the match
 * against the retired second build (accounts.originating_dealer_lead_id,
 * account_ownership_history.to_owner_id, r.dealer_linked), which failed on
 * every database.
 *
 * `ownership` = the E-321 tables exist (hasAccountOwnershipTables). Without
 * them matchedUnion gives no account, and r.dealer_owner_id is the lead's
 * current owner. `ledger` = E-322 (hasInvoiceLedgerTables): credit_notes
 * exists, and the union carries credit notes (source 'credit', ID 71).
 */
const invoicesFrom = (src: SQL, ownership: boolean, ledger: boolean): SQL => sql`
      FROM ${src} AS r
      LEFT JOIN sales_invoices si ON r.source = 'drive' AND si.id::text = r.id
      LEFT JOIN zoho_invoices zi ON r.source = 'zoho' AND zi.id::text = r.id
      ${ledger ? sql`LEFT JOIN credit_notes cn ON r.source = 'credit' AND cn.id::text = r.id` : sql``}
      LEFT JOIN dealer_leads idl ON idl.id = r.dealer_lead_id
      LEFT JOIN accounts acct ON acct.id = r.account_id
      ${ownership ? sql`LEFT JOIN account_ownership iao ON iao.account_id = r.account_id` : sql``}
      -- Owner today: the account's current owner, else the matched lead's owner.
      LEFT JOIN users ow ON ow.id::text = ${
          ownership
              ? sql`CASE WHEN r.account_id IS NOT NULL THEN iao.owner_user_id::text ELSE idl.current_owner_id::text END`
              : sql`idl.current_owner_id::text`
      }
      -- Owner on the invoice date: only an account carries owner history.
      LEFT JOIN users oh ON r.account_id IS NOT NULL AND oh.id::text = r.dealer_owner_id::text
`;
/** "Linked" = an account or a lead matched — revenueSource.ts MATCHED_TO_DEALER. */
const INVOICE_LINKED = sql`(r.account_id IS NOT NULL OR r.dealer_lead_id IS NOT NULL)`;
const INVOICE_PAID_ON = sql`COALESCE(si.last_payment_date, zi.last_payment_date)`;

function invoicesWhere(ctx: RunContext): SQL {
    const conds: SQL[] = [dayRange(ctx.params, ctx.params.get("date_field") === "paid" ? INVOICE_PAID_ON : sql`r.invoice_date`)];
    const status = ctx.params.get("status");
    conds.push(status && INVOICE_STATUSES.includes(status) ? sql`r.status = ${status}` : REVENUE_NOT_VOID);
    const source = ctx.params.get("source");
    if (source && INVOICE_SOURCES.includes(source)) conds.push(sql`r.source = ${source}`);
    const link = ctx.params.get("link");
    // "Linked" = a lead OR a dealer account matched the GSTIN (gstinMatch.ts),
    // the same rule the Sales invoices page and the data-health check count by.
    if (link === "linked") conds.push(INVOICE_LINKED);
    if (link === "unlinked") conds.push(sql`NOT ${INVOICE_LINKED}`);
    conds.push(...commonConds(ctx, { person: sql`r.dealer_owner_id` }));
    return sql.join(conds, sql` AND `);
}

const invoicesDataset: Dataset = {
    id: "invoices",
    label: "Invoices",
    description: "One row per sales invoice, from the old Zoho books and the Vyapar PDFs in Google Drive, and one per credit note (a negative row), linked to its dealer on GSTIN. Void invoices are left out unless you pick that status.",
    roles: ["admin", "ceo"],
    dateFields: [
        { value: "invoice", label: "Invoice date" },
        { value: "paid", label: "Paid on" },
    ],
    commonFilters: ["person"],
    background: true,
    filters: [
        { key: "status", label: "Status", type: "select", options: INVOICE_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, " ") })) },
        {
            key: "source",
            label: "Source",
            type: "select",
            options: [{ value: "drive", label: "Drive (Vyapar)" }, { value: "zoho", label: "Zoho" }, { value: "credit", label: "Credit notes" }],
        },
        { key: "link", label: "Linked to a dealer", type: "select", options: [{ value: "linked", label: "Linked" }, { value: "unlinked", label: "Not linked" }] },
    ],
    sheets: [
        {
            name: "Invoices",
            columns: [
                { key: "invoice_number", header: "Invoice no.", meaning: "Invoice number as printed." },
                { key: "invoice_date", header: "Invoice date", meaning: "Date on the invoice.", kind: "date" },
                { key: "due_date", header: "Due date", meaning: "Payment due date.", kind: "date" },
                { key: "source", header: "Source", meaning: "'drive' = Vyapar PDF in Google Drive; 'zoho' = the old Zoho books; 'credit' = a credit note (money given back to the dealer), shown as a negative row." },
                { key: "entity", header: "Entity", meaning: "The iTarang entity that raised it: Delhi or Haryana." },
                { key: "customer_name", header: "Customer on invoice", meaning: "The name typed on the invoice.", width: 30 },
                { key: "gstin", header: "Customer GSTIN", meaning: "GSTIN on the invoice. Zoho invoices mostly carry none." },
                { key: "dealer_name", header: "Linked dealer", meaning: "The CRM dealer matched on GSTIN.", width: 28 },
                { key: "dealer_lead_id", header: "Linked lead ID", meaning: "That dealer's lead id. Blank when only a dealer account matched.", width: 24 },
                { key: "link_status", header: "Link status", meaning: "'Linked' when the GSTIN matched a CRM dealer: a lead or a dealer account." },
                { key: "business_type", header: "Type of business", meaning: "The linked dealer's type of business." },
                { key: "account", header: "Linked account", meaning: "The dealer account with this GSTIN, or the one that came from the linked lead.", width: 28 },
                { key: "dealer_owner", header: "Dealer's owner today", meaning: "The linked dealer's current owner.", width: 22 },
                { key: "owner_on_invoice_date", header: "Account owner on invoice date", meaning: "Who owned the linked account on the invoice date. Blank when the account had no recorded owner by then.", width: 24 },
                { key: "sub_total", header: "Before GST (₹)", meaning: "Amount before GST. Drive (Vyapar) invoices and credit notes (negative) only; Zoho rows carry the total alone.", kind: "money" },
                { key: "tax_total", header: "GST (₹)", meaning: "GST on the invoice. Drive (Vyapar) invoices and credit notes (negative) only.", kind: "money" },
                { key: "total", header: "Total (₹)", meaning: "Invoice total including GST. A credit note is negative, so summing the column gives revenue less credit notes, as the Revenue card does.", kind: "money" },
                { key: "paid", header: "Paid (₹)", meaning: "Total minus balance. Always 0 on a credit note.", kind: "money" },
                {
                    key: "balance",
                    header: "Balance (₹)",
                    meaning:
                        "Still owed on this invoice; a credit note's balance is its (negative) amount. The column does NOT add up to Money owed on the dashboards: Money owed nets each customer's credit notes against their unpaid invoices only (paid, void and draft invoices left out) and never goes below zero for a customer.",
                    kind: "money",
                },
                { key: "status", header: "Status", meaning: "Draft, sent, overdue, paid, partially paid or void; 'credit_note' on a credit note that is not void." },
                { key: "days_overdue", header: "Days overdue", meaning: "Days past the due date while a balance is still owed. Blank = not overdue.", kind: "number" },
                { key: "paid_on", header: "Paid on", meaning: "Date of the latest payment recorded.", kind: "date" },
                { key: "payment_reference", header: "Payment reference", meaning: "UTR or bank reference of the latest payment.", width: 24 },
                { key: "attention_reason", header: "Needs checking", meaning: "Why the invoice was flagged when it was read, if it was.", width: 36 },
            ],
        },
    ],
    async count(ctx) {
        const [src, ownership, ledger] = await Promise.all([matchedUnion(), hasAccountOwnershipTables(), hasInvoiceLedgerTables()]);
        const [r] = await rows<{ n: number }>(sql`SELECT COUNT(*)::int AS n ${invoicesFrom(src, ownership, ledger)} WHERE ${invoicesWhere(ctx)}`);
        return Number(r?.n ?? 0);
    },
    async build(ctx) {
        const [src, ownership, ledger] = await Promise.all([matchedUnion(), hasAccountOwnershipTables(), hasInvoiceLedgerTables()]);
        const data = await rows(sql`
            SELECT r.invoice_number, r.invoice_date, r.due_date, r.source,
                   CASE r.organization_id WHEN '60064046518' THEN 'Delhi' WHEN '60060919257' THEN 'Haryana'
                        ELSE r.organization_id END AS entity,
                   r.customer_name, r.gstin_key AS gstin, r.dealer_name, r.dealer_lead_id,
                   CASE WHEN ${INVOICE_LINKED} THEN 'Linked' ELSE 'Not linked' END AS link_status,
                   to_jsonb(idl) ->> 'business_type' AS business_type,
                   acct.business_entity_name AS account,
                   ow.name AS dealer_owner, oh.name AS owner_on_invoice_date,
                   ${ledger ? sql`COALESCE(si.sub_total, -cn.sub_total)` : sql`si.sub_total`} AS sub_total,
                   ${ledger ? sql`COALESCE(si.tax_total, -cn.tax_total)` : sql`si.tax_total`} AS tax_total,
                   r.total, (COALESCE(r.total, 0) - COALESCE(r.balance, 0)) AS paid, r.balance, r.status,
                   CASE WHEN ${REVENUE_OUTSTANDING} AND r.due_date < ${IST_TODAY} THEN ${IST_TODAY} - r.due_date END AS days_overdue,
                   ${INVOICE_PAID_ON} AS paid_on, r.payment_reference, r.attention_reason
              ${invoicesFrom(src, ownership, ledger)}
             WHERE ${invoicesWhere(ctx)}
             ORDER BY r.invoice_date DESC NULLS LAST
             LIMIT ${rowLimit(ctx)}
        `);
        return [{ ...this.sheets[0], rows: data.map((r) => ({ ...r, business_type: r.dealer_lead_id ? businessTypeLabel(r.business_type as string | null) : null })) }];
    },
};

// ───────────────────────────────── Expenses ─────────────────────────────────

function expensesWhere(ctx: RunContext): SQL {
    // The effective expense day: the date on the bill, else the day it was entered.
    const day =
        ctx.params.get("date_field") === "approved"
            ? sql`(e.approved_at AT TIME ZONE 'Asia/Kolkata')::date`
            : sql`COALESCE(e.expense_date, (e.created_at AT TIME ZONE 'Asia/Kolkata')::date)`;
    const conds: SQL[] = [dayRange(ctx.params, day)];
    const status = ctx.params.get("status");
    if (status) conds.push(sql`e.status = ${status}`);
    const department = ctx.params.get("department");
    if (department) conds.push(sql`e.department ILIKE ${department}`);
    const category = ctx.params.get("category");
    if (category) conds.push(sql`e.category ILIKE ${category}`);
    conds.push(...commonConds(ctx, { person: sql`e.submitted_by` }));
    return sql.join(conds, sql` AND `);
}

const expenses: Dataset = {
    id: "expenses",
    label: "Expenses",
    description: "One row per expense — typed in, uploaded, or read from the Drive folders — with its approval.",
    roles: ["admin", "ceo"],
    dateFields: [
        { value: "expense", label: "Expense date" },
        { value: "approved", label: "Approved on" },
    ],
    commonFilters: ["person"],
    background: true,
    filters: [
        { key: "status", label: "Status", type: "select", options: ["pending", "approved", "rejected"].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })) },
        { key: "department", label: "Department", type: "text" },
        { key: "category", label: "Category", type: "text" },
    ],
    sheets: [
        {
            name: "Expenses",
            columns: [
                { key: "expense_date", header: "Expense date", meaning: "The date on the bill; when it has none, the day it was entered.", kind: "date" },
                { key: "submitted_by", header: "Submitted by", meaning: "Who entered or uploaded it.", width: 22 },
                { key: "department", header: "Department", meaning: "Department the spend belongs to." },
                { key: "project_tag", header: "Project", meaning: "Project tag, when one was given." },
                { key: "bucket", header: "Bucket", meaning: "Tech, RM, misc or others — the CEO dashboard's top-level split." },
                { key: "category", header: "Category", meaning: "Expense category." },
                { key: "vendor", header: "Vendor", meaning: "Who was paid.", width: 26 },
                { key: "description", header: "Description", meaning: "What it was for.", width: 40 },
                { key: "invoice_number", header: "Bill no.", meaning: "The vendor's bill number." },
                { key: "amount", header: "Amount (₹)", meaning: "Always rupees — a foreign bill is converted when it is entered.", kind: "money" },
                { key: "currency", header: "Bill currency", meaning: "The currency printed on the bill, when not rupees." },
                { key: "original_amount", header: "Bill amount", meaning: "The amount in the bill's own currency.", kind: "money" },
                { key: "status", header: "Status", meaning: "Pending, approved or rejected." },
                { key: "approved_by", header: "Approved by", meaning: "Who approved or rejected it.", width: 22 },
                { key: "approved_at", header: "Approved on", meaning: "When it was approved.", kind: "datetime" },
                { key: "rejection_reason", header: "Rejection reason", meaning: "Why it was rejected, when it was.", width: 30 },
                { key: "source", header: "Entered through", meaning: "'manual' = typed in; 'ai' = read from an uploaded or Drive bill." },
                { key: "attention_reason", header: "Needs checking", meaning: "Why the row was flagged when it was read, if it was.", width: 30 },
                { key: "bill_url", header: "Bill link", meaning: "A CRM link to the bill. Clicking it checks who you are (Finance, Admin, CEO or whoever submitted it) and then opens it through a fresh link that lasts 15 minutes; the file itself never sits in this download.", width: 40 },
            ],
        },
    ],
    async count(ctx) {
        const [r] = await rows<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM expense_submissions e WHERE ${expensesWhere(ctx)}`);
        return Number(r?.n ?? 0);
    },
    async build(ctx) {
        const data = await rows(sql`
            SELECT COALESCE(e.expense_date, (e.created_at AT TIME ZONE 'Asia/Kolkata')::date) AS expense_date,
                   su.name AS submitted_by, e.department, e.project_tag, e.bucket, e.category, e.vendor,
                   e.description, e.invoice_number, e.amount, e.currency, e.original_amount, e.status,
                   ab.name AS approved_by, e.approved_at, e.rejection_reason, e.source,
                   CASE WHEN e.needs_attention THEN COALESCE(e.attention_reason, 'Flagged') END AS attention_reason,
                   e.bill_url
              FROM expense_submissions e
              LEFT JOIN users su ON su.id = e.submitted_by
              LEFT JOIN users ab ON ab.id = e.approved_by
             WHERE ${expensesWhere(ctx)}
             ORDER BY expense_date DESC
             LIMIT ${rowLimit(ctx)}
        `);
        // ID 166: a checked CRM link, never the stored bill link.
        const origin = exportOrigin();
        return [{ ...this.sheets[0], rows: data.map((r) => ({ ...r, bill_url: billCell(r.bill_url, origin) })) }];
    },
};

// ───────────────────────────────── Buyback ──────────────────────────────────

const BUYBACK_STAGES = [
    "DRAFT", "SUBMITTED", "UNDER_REVIEW", "INFO_REQUESTED", "NEGOTIATING", "FINAL_OFFER_SENT", "DEALER_ACCEPTED",
    "MARGIN_SET", "VENDOR_ROUTED", "VENDOR_NEGOTIATING", "VENDOR_AGREED", "DEALER_REOPENED", "PO_EXCHANGED",
    "PICKUP_SCHEDULED", "PICKED_UP", "INVOICE_RAISED", "INVOICE_APPROVED", "SETTLED", "CLOSED", "REJECTED", "CANCELLED",
];

/** One row per request, with the same kg, pickup and ₹-paid rules as the Buyback Daily email. */
const buybackFrom = sql`
      FROM buyback_requests br
      LEFT JOIN buyback_deals d ON d.request_id = br.id
      LEFT JOIN accounts a ON a.id = br.dealer_entity_id
      LEFT JOIN users ow ON ow.id::text = br.owner_id
      LEFT JOIN LATERAL (
          SELECT COUNT(*) AS lines, COALESCE(SUM(l.quantity), 0) AS units,
                 COALESCE(SUM(l.quantity * l.unit_weight_kg), 0) AS kg,
                 COUNT(*) FILTER (WHERE COALESCE(l.unit_weight_kg, 0) <= 0) AS missing_weight
            FROM buyback_batches b JOIN buyback_lines l ON l.batch_id = b.id
           WHERE b.request_id = br.id
      ) k ON TRUE
      LEFT JOIN LATERAL (
          SELECT MIN(al.created_at) AS at FROM buyback_activity_log al
           WHERE al.request_id = br.id AND al.action = 'complete_pickup'
      ) pk ON TRUE
      LEFT JOIN LATERAL (
          SELECT SUM(st.amount) AS amount, MAX(st.txn_date) AS paid_on, string_agg(DISTINCT st.txn_ref, ', ') AS refs
            FROM settlement_transactions st WHERE st.deal_id = d.id AND st.leg = 'DEALER'
      ) pd ON TRUE
      LEFT JOIN LATERAL (
          SELECT SUM(fl.price_per_unit * l.quantity) AS amount
            FROM final_offer_lines fl JOIN buyback_lines l ON l.id = fl.line_id
           WHERE fl.final_offer_id = (SELECT f.id FROM final_offers f WHERE f.deal_id = d.id ORDER BY f.version_no DESC LIMIT 1)
      ) fo ON TRUE
      LEFT JOIN LATERAL (
          SELECT va.business_entity_name AS name
            FROM vendor_threads vt JOIN scrap_vendors sv ON sv.id = vt.vendor_id JOIN accounts va ON va.id = sv.entity_id
           WHERE vt.deal_id = d.id AND vt.status::text = 'AGREED' LIMIT 1
      ) vn ON TRUE
      LEFT JOIN LATERAL (
          SELECT SUM(${jnum(sql`ac ->> 'quantity'`)} * l.unit_weight_kg) AS kg
            FROM pickups p
           CROSS JOIN LATERAL jsonb_array_elements(${jarr(sql`p.actual_counts`)}) ac
            JOIN buyback_lines l ON l.id::text = ac ->> 'line_id'
           WHERE p.deal_id = d.id AND p.completed_at IS NOT NULL
      ) pkg ON TRUE
`;

const BUYBACK_DAYS: Record<string, SQL> = {
    requested: sql`(COALESCE(br.submitted_at, br.created_at) AT TIME ZONE 'Asia/Kolkata')::date`,
    picked_up: sql`(pk.at AT TIME ZONE 'Asia/Kolkata')::date`,
    paid: sql`pd.paid_on`,
};

function buybackWhere(ctx: RunContext): SQL {
    const day = BUYBACK_DAYS[ctx.params.get("date_field") ?? "requested"] ?? BUYBACK_DAYS.requested;
    const conds: SQL[] = [dayRange(ctx.params, day)];
    const stage = ctx.params.get("stage");
    if (stage) conds.push(sql`d.status::text = ${stage}`);
    if (ctx.params.get("no_owner") === "1") conds.push(sql`br.owner_id IS NULL`);
    const vendor = ctx.params.get("vendor")?.trim();
    if (vendor) conds.push(sql`vn.name ILIKE ${"%" + vendor + "%"}`);
    conds.push(...commonConds(ctx, { person: sql`br.owner_id`, state: sql`a.state` }));
    return sql.join(conds, sql` AND `);
}

const buyback: Dataset = {
    id: "buyback",
    label: "Buyback",
    description: "One row per buyback request, with its stage, weight, the latest offer and what has been paid to the dealer.",
    roles: BUYBACK_ADMIN_ROLES,
    dateFields: [
        { value: "requested", label: "Requested" },
        { value: "picked_up", label: "Picked up" },
        { value: "paid", label: "Paid" },
    ],
    commonFilters: ["person", "state"],
    background: true,
    filters: [
        { key: "stage", label: "Stage", type: "select", options: BUYBACK_STAGES.map((s) => ({ value: s, label: s.replace(/_/g, " ").toLowerCase() })) },
        { key: "no_owner", label: "No owner only", type: "select", options: yesNo },
        { key: "vendor", label: "Scrap vendor contains", type: "text" },
    ],
    sheets: [
        {
            name: "Buyback",
            columns: [
                { key: "request_no", header: "Request no.", meaning: "The buyback request's reference." },
                { key: "dealer", header: "Dealer", meaning: "The dealer selling the batteries.", width: 30 },
                { key: "owner", header: "Owner", meaning: "The person who owns the request. Blank = no owner yet.", width: 22 },
                { key: "source_channel", header: "Came through", meaning: "Web, WhatsApp or CSV." },
                { key: "requested_on", header: "Requested on", meaning: "When the request was submitted; for a draft, when it was started.", kind: "datetime" },
                { key: "stage", header: "Stage", meaning: "Where the deal stands now.", width: 22 },
                { key: "lines", header: "Lines", meaning: "Battery lines on the request.", kind: "number" },
                { key: "units", header: "Units", meaning: "Batteries across those lines.", kind: "number" },
                { key: "kg", header: "Kg quoted", meaning: "Quantity × unit weight over the lines. A line with no weight counts 0.", kind: "number" },
                { key: "missing_weight", header: "Lines missing weight", meaning: "Lines with no unit weight — the kg figure is under-counted by these.", kind: "number" },
                { key: "kg_picked_up", header: "Kg picked up", meaning: "Units counted at pickup × unit weight. There is no weighbridge figure in the CRM, so this is a counted weight, not a weighed one.", kind: "number" },
                { key: "picked_up_on", header: "Picked up on", meaning: "When pickup was completed.", kind: "datetime" },
                { key: "vendor", header: "Scrap vendor", meaning: "The recycler the deal was agreed with. Blank until one is agreed.", width: 28 },
                { key: "offer", header: "Offer (₹)", meaning: "Total of the latest final offer sent to the dealer.", kind: "money" },
                { key: "paid", header: "Paid (₹)", meaning: "Everything paid out on the dealer side of the deal.", kind: "money" },
                { key: "per_kg", header: "₹ per kg", meaning: "Paid ÷ kg quoted. Blank when nothing was paid or weighed.", kind: "money" },
                { key: "paid_on", header: "Paid on", meaning: "Date of the latest payment.", kind: "date" },
                { key: "payment_reference", header: "Payment reference", meaning: "Bank reference(s) on those payments.", width: 26 },
            ],
        },
    ],
    async count(ctx) {
        const [r] = await rows<{ n: number }>(sql`SELECT COUNT(*)::int AS n ${buybackFrom} WHERE ${buybackWhere(ctx)}`);
        return Number(r?.n ?? 0);
    },
    async build(ctx) {
        const data = await rows(sql`
            SELECT br.request_no, a.business_entity_name AS dealer, ow.name AS owner, br.source_channel::text AS source_channel,
                   COALESCE(br.submitted_at, br.created_at) AS requested_on,
                   replace(lower(d.status::text), '_', ' ') AS stage,
                   k.lines, k.units, k.kg, k.missing_weight, pkg.kg AS kg_picked_up, pk.at AS picked_up_on, vn.name AS vendor,
                   fo.amount AS offer, pd.amount AS paid,
                   CASE WHEN k.kg > 0 AND pd.amount IS NOT NULL THEN ROUND(pd.amount / k.kg, 2) END AS per_kg,
                   pd.paid_on, pd.refs AS payment_reference
              ${buybackFrom}
             WHERE ${buybackWhere(ctx)}
             ORDER BY COALESCE(br.submitted_at, br.created_at) DESC
             LIMIT ${rowLimit(ctx)}
        `);
        return [{ ...this.sheets[0], rows: data }];
    },
};

// ──────────────────────────────── Inventory ─────────────────────────────────

function inventoryWhere(ctx: RunContext): SQL {
    const conds: SQL[] = [dayRange(ctx.params, sql`(i.oem_invoice_date AT TIME ZONE 'Asia/Kolkata')::date`, "all")];
    const status = ctx.params.get("status");
    if (status) conds.push(sql`i.status = ${status}`);
    const assetType = ctx.params.get("asset_type");
    if (assetType) conds.push(sql`i.asset_type ILIKE ${assetType}`);
    const product = ctx.params.get("product");
    if (product) conds.push(sql`i.model_type ILIKE ${"%" + product + "%"}`);
    const location = ctx.params.get("location");
    if (location) conds.push(sql`i.warehouse_location ILIKE ${"%" + location + "%"}`);
    return sql.join(conds, sql` AND `);
}

const inventoryDataset: Dataset = {
    id: "inventory",
    label: "Inventory",
    description: "One row per battery or item in inventory, with its OEM invoice, cost, status and where it is.",
    roles: [...MANAGERS, "inventory_manager"],
    dateFields: [{ value: "oem_invoice", label: "OEM invoice date" }],
    allWhenNoDates: true,
    background: true,
    filters: [
        { key: "status", label: "Status", type: "select", options: INVENTORY_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, " ") })) },
        { key: "asset_type", label: "Asset type", type: "text" },
        { key: "product", label: "Product / model contains", type: "text" },
        { key: "location", label: "Location contains", type: "text" },
    ],
    sheets: [
        {
            name: "Inventory",
            columns: [
                { key: "id", header: "Inventory ID", meaning: "The item's id in the CRM.", width: 26 },
                { key: "serial_number", header: "Serial no.", meaning: "Serial number; blank on items that are not serialised.", width: 24 },
                { key: "model_type", header: "Product / model", meaning: "Model of the item.", width: 28 },
                { key: "asset_category", header: "Asset category", meaning: "The item's category." },
                { key: "asset_type", header: "Asset type", meaning: "Battery, charger, and so on." },
                { key: "quantity", header: "Quantity", meaning: "Units on the row; items without serial numbers are held as a quantity.", kind: "number" },
                { key: "oem_name", header: "OEM", meaning: "Who it was bought from.", width: 22 },
                { key: "oem_invoice_number", header: "OEM invoice no.", meaning: "The OEM's invoice number." },
                { key: "oem_invoice_date", header: "OEM invoice date", meaning: "Date on the OEM's invoice.", kind: "datetime" },
                { key: "inventory_amount", header: "Cost before GST (₹)", meaning: "Base value of the item.", kind: "money" },
                { key: "gst_amount", header: "GST (₹)", meaning: "GST on the base value.", kind: "money" },
                { key: "with_gst", header: "Cost with GST (₹)", meaning: "Base value plus GST.", kind: "money" },
                { key: "status", header: "Status", meaning: "Available, reserved, dispatched, sold, written off or transferred." },
                { key: "warehouse_location", header: "Location", meaning: "Warehouse location." },
                { key: "dealer", header: "With dealer", meaning: "The dealer it is allocated or sold to, when it is.", width: 28 },
                { key: "received_date", header: "Received on", meaning: "When it reached iTarang.", kind: "datetime" },
                { key: "sold_at", header: "Sold on", meaning: "When it was sold.", kind: "datetime" },
                { key: "days_in_stock", header: "Days in stock", meaning: "Days from receipt (else OEM invoice, else upload) to the sale, or to today when unsold.", kind: "number" },
                // ID 173: same as the Admin › Inventory download.
                { key: "uploaded_by", header: "Uploaded by", meaning: "The login that added the item (name, else email).", width: 24 },
                { key: "upload_batch", header: "Upload batch", meaning: "The stock upload the item came in; blank for items added one by one or before batches were recorded.", width: 26 },
            ],
        },
    ],
    async count(ctx) {
        const [r] = await rows<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM inventory i WHERE ${inventoryWhere(ctx)}`);
        return Number(r?.n ?? 0);
    },
    async build(ctx) {
        const data = await rows(sql`
            SELECT i.id, i.serial_number, i.model_type, i.asset_category, i.asset_type, i.quantity, i.oem_name,
                   i.oem_invoice_number, i.oem_invoice_date, i.inventory_amount, i.gst_amount,
                   COALESCE(i.price_inclusive_gst, i.final_amount) AS with_gst,
                   i.status, i.warehouse_location, a.business_entity_name AS dealer, i.received_date, i.sold_at,
                   ((COALESCE(i.sold_at, now()) AT TIME ZONE 'Asia/Kolkata')::date
                    - (COALESCE(i.received_date, i.oem_invoice_date, i.created_at) AT TIME ZONE 'Asia/Kolkata')::date) AS days_in_stock,
                   COALESCE(u.name, u.email) AS uploaded_by, i.upload_event_id AS upload_batch
              FROM inventory i
              LEFT JOIN accounts a ON a.id = i.dealer_id
              LEFT JOIN users u ON u.id = i.created_by
             WHERE ${inventoryWhere(ctx)}
             ORDER BY i.oem_invoice_date DESC NULLS LAST, i.id
             LIMIT ${rowLimit(ctx)}
        `);
        return [{ ...this.sheets[0], rows: data }];
    },
};

// ─────────────────────────────── Ecofy leads ────────────────────────────────

// ID 51 — Ecofy leads (E-305 / E-307) in Reports › Data downloads, with the
// columns of the workspace's own CSV (/api/ecofy/leads/export). A CRM-side
// file: owner names are fine here, they never go to Ecofy. Read behind a
// to_regclass probe, so a database without E-305 gives an empty file.
const ECOFY_DATES: Record<string, SQL> = {
    created: sql`e.created_at`,
    queue: sql`e.queue_entered_at`,
    assigned: sql`e.assigned_at`,
};

async function hasEcofyLeads(): Promise<boolean> {
    const [r] = await rows<{ ok: boolean }>(sql`SELECT to_regclass('public.ecofy_leads') IS NOT NULL AS ok`);
    return Boolean(r?.ok);
}

function ecofyWhere(ctx: RunContext): SQL {
    const day = ECOFY_DATES[ctx.params.get("date_field") ?? ""] ?? ECOFY_DATES.created;
    const conds: SQL[] = [dateRange(ctx.params, day)];
    // ASM / ISR: the leads the Sales Head assigned to them, as on their Ecofy page.
    if (ctx.ownOnly) conds.push(sql`e.assigned_to_user_id::text = ${ctx.user.id}`);
    const view = ctx.params.get("view");
    // Same rules as the workspace tabs (src/lib/ecofy/queries.ts).
    if (view === "open") conds.push(sql`(e.stage IS NULL OR e.stage NOT IN ('S0', 'CLOSED'))`);
    else if (view === "queue") conds.push(sql`(e.stage = 'S1' AND e.assigned_to_user_id IS NULL)`);
    else if (view === "closed") conds.push(sql`e.stage IN ('S0', 'CLOSED')`);
    const stage = ctx.params.get("stage");
    if (stage) conds.push(sql`e.stage = ${stage}`);
    const temp = ctx.params.get("temperature");
    if (temp) conds.push(sql`upper(e.temperature) = ${temp.toUpperCase()}`);
    const segment = ctx.params.get("segment");
    if (segment) conds.push(sql`upper(e.segment) = ${segment.toUpperCase()}`);
    conds.push(...commonConds(ctx, { person: sql`e.assigned_to_user_id`, state: sql`e.state` }));
    return sql.join(conds, sql` AND `);
}

const ecofyLeadsDataset: Dataset = {
    id: "ecofy_leads",
    label: "Ecofy leads",
    description: "One row per Ecofy lead (solar / storage cases pushed from Ecofy): stage, temperature, owner, follow-up and meeting dates, and when it entered the pickup queue.",
    roles: MANAGERS,
    ownRowsRoles: ["asm", "inside_sales_rep"],
    dateFields: [
        { value: "created", label: "Came in from Ecofy" },
        { value: "queue", label: "Entered pickup queue" },
        { value: "assigned", label: "Assigned" },
    ],
    commonFilters: ["team", "person", "state"],
    filters: [
        {
            key: "view",
            label: "Leads",
            type: "select",
            options: [
                { value: "open", label: "Open" },
                { value: "queue", label: "Pickup queue (unassigned)" },
                { value: "closed", label: "Returned or closed" },
            ],
        },
        {
            key: "stage",
            label: "Stage",
            type: "select",
            options: Object.entries(ECOFY_STAGE_LABELS).map(([value, label]) => ({ value, label: `${value} · ${label}` })),
        },
        {
            key: "temperature",
            label: "Temperature",
            type: "select",
            options: ["HOT", "WARM", "COLD"].map((t) => ({ value: t, label: csvPretty(t.toLowerCase()) })),
        },
        { key: "segment", label: "Segment", type: "select", options: ECOFY_SEGMENTS.map((s) => ({ value: s, label: s })) },
    ],
    sheets: [
        {
            name: "Ecofy leads",
            columns: [
                { key: "case_no", header: "Case", meaning: "Ecofy's case number.", width: 16 },
                { key: "segment", header: "Segment", meaning: "RESI, ESS or CI." },
                { key: "customer_name", header: "Customer", meaning: "Customer name on the case.", width: 24 },
                { key: "customer_mobile", header: "Mobile Number", meaning: "Customer's mobile. Masked unless full numbers were requested with a reason.", kind: "phone" },
                { key: "city", header: "City", meaning: "Customer's city." },
                { key: "state", header: "State", meaning: "Customer's state." },
                { key: "stage", header: "Stage", meaning: "Ecofy stage code and name (S1 = pickup queue … S8 = asset, Closed).", width: 24 },
                { key: "sub_status", header: "Sub-status", meaning: "Ecofy's sub-status within the stage.", width: 20 },
                { key: "temperature", header: "Temperature", meaning: "Hot, warm or cold." },
                { key: "product_interest", header: "Product Interest", meaning: "What the customer asked about.", width: 18 },
                { key: "owner", header: "Owner", meaning: "The CRM person the lead is assigned to. Blank = not assigned.", width: 22 },
                { key: "owner_role", header: "Owner Role", meaning: "That person's role on the assignment." },
                { key: "next_follow_up_at", header: "Next Follow-up", meaning: "Next follow-up set in the CRM.", kind: "datetime" },
                { key: "next_appointment_at", header: "Next Meeting", meaning: "Next meeting booked.", kind: "datetime" },
                { key: "queue_entered_at", header: "In Queue Since", meaning: "When the lead entered the pickup queue.", kind: "datetime" },
                { key: "assigned_at", header: "Assigned on", meaning: "When it was assigned to the owner.", kind: "datetime" },
                { key: "created_at", header: "Came in", meaning: "When the CRM first received the lead from Ecofy.", kind: "datetime" },
                { key: "closure_reason", header: "Closure reason", meaning: "Why it was closed, when it was.", width: 20 },
            ],
        },
    ],
    async count(ctx) {
        if (!(await hasEcofyLeads())) return 0;
        const [r] = await rows<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM ecofy_leads e WHERE ${ecofyWhere(ctx)}`);
        return Number(r?.n ?? 0);
    },
    async build(ctx) {
        if (!(await hasEcofyLeads())) return [{ ...this.sheets[0], rows: [] }];
        const data = await rows<Record<string, unknown>>(sql`
            SELECT e.case_no, e.segment, e.customer_name, e.customer_mobile, e.city, e.state,
                   e.stage, e.sub_status, e.temperature, e.product_interest,
                   u.name AS owner, e.assigned_role, e.next_follow_up_at, e.next_appointment_at,
                   e.queue_entered_at, e.assigned_at, e.created_at, e.closure_reason
              FROM ecofy_leads e
              LEFT JOIN users u ON u.id::text = e.assigned_to_user_id::text
             WHERE ${ecofyWhere(ctx)}
             ORDER BY e.created_at DESC
             LIMIT ${rowLimit(ctx)}
        `);
        return [
            {
                ...this.sheets[0],
                rows: data.map((r) => {
                    const stage = r.stage ? String(r.stage) : null;
                    const role = r.assigned_role ? String(r.assigned_role) : null;
                    return {
                        ...r,
                        // Through the same label maps the workspace CSV uses.
                        stage: stage ? `${stage} · ${ECOFY_STAGE_LABELS[stage] ?? stage}` : null,
                        sub_status: csvPretty(r.sub_status) || null,
                        temperature: csvPretty(r.temperature) || null,
                        product_interest: csvPretty(r.product_interest) || null,
                        owner_role: role ? ECOFY_ROLE_LABEL[role] ?? role : null,
                    };
                }),
            },
        ];
    },
};

export const DATASETS: readonly Dataset[] = [
    leads, leadEvents, calls, visits, quotes, targets, dealerAccounts, dealerOnboarding,
    invoicesDataset, expenses, customerLoanFiles, buyback, inventoryDataset, ecofyLeadsDataset,
];

export function datasetById(id: string): Dataset | undefined {
    return DATASETS.find((d) => d.id === id);
}

/** May this role download the dataset, and if so only its own rows? null = no access. */
export function datasetAccess(dataset: DatasetInfo, role: string | null | undefined): { ownOnly: boolean } | null {
    const r = (role ?? "").toLowerCase();
    if (dataset.roles.includes(r)) return { ownOnly: false };
    if (dataset.ownRowsRoles?.includes(r)) return { ownOnly: true };
    return null;
}

/** The catalogue as the page needs it — no functions. */
export function datasetInfo(d: Dataset): DatasetInfo {
    const { id, label, description, roles, ownRowsRoles, dateFields, allWhenNoDates, filters, commonFilters, background, sheets } = d;
    return { id, label, description, roles, ownRowsRoles, dateFields, allWhenNoDates, filters, commonFilters, background, sheets };
}
