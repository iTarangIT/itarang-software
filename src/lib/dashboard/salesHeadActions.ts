/**
 * Sales Head "Needs action now" — the seven tiles beyond idle / dealer health:
 *
 *   sales_ready         Sales-ready leads with no owner (salesReady.ts — the
 *                       Ready to Assign list's own predicate)
 *   hot_not_called      Hot lead with an owner, no call or visit since it
 *                       reached that owner, more than HOT_FIRST_CALL_LIMIT_HOURS
 *                       working hours ago (workingHours.ts: Mon–Sat 10–19 IST)
 *   visit_overdue       Transferred to an ASM, first visit past the admin-set
 *                       limit (transferVisitLimit.ts — the admin panel's rule)
 *   quotes_no_answer    Latest quote delivered to the dealer more than
 *                       QUOTE_NO_ANSWER_WORKING_DAYS working days ago, no
 *                       answer, not withdrawn, lead still open
 *   said_yes            Dealer approved the quote, lead not marked Won
 *                       (saidYesNotWon.ts — the CEO card's list)
 *   onboarding_stalled  Won lead whose onboarding stalled, on the dealer or on
 *                       us (admin/dashboard.ts ONBOARDING_STALLED)
 *   won_without_quote   Marked Won this month with no dealer-approved quote
 *                       (admin/dashboard.ts WON_WITHOUT_QUOTE)
 *   hot_aged            Open lead rated Hot for more than 7 days — the rows
 *                       behind the tile the sales dashboard counts
 *                       (salesDashboard.ts queryInterest: interest_level
 *                       'hot', active, not Converted / Lost, IST days since
 *                       interest_changed_at)
 *
 * One function returns a tile's ROWS; the tile's count and sub-line are made
 * from those rows, so the card and the list it opens cannot disagree. Each
 * tile is built on its own and is `null` when its source is missing on this
 * database — one broken tile never blanks the others.
 */
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { ONB_LAST, ONB_WAITING_ON, ONBOARDING_STALLED, WON_WITHOUT_QUOTE } from "@/lib/admin/dashboard";
import { awaitingAssignment, daysAwaitingAssignment } from "@/lib/leads/salesReady";
import { listSaidYesNotWon } from "@/lib/leads/saidYesNotWon";
import {
    TRANSFER_AT_EXPR,
    TRANSFER_VISIT_OVERDUE_SQL,
    TRANSFER_WORKING_DAYS_SQL,
    getAsmTransferVisitLimit,
} from "@/lib/asm/transferVisitLimit";
import { WORKABLE_STATUSES } from "@/lib/lifecycle/transitions";
import { workingHoursBetween } from "@/lib/leads/workingHours";

export const HOT_FIRST_CALL_LIMIT_HOURS = 4;
export const QUOTE_NO_ANSWER_WORKING_DAYS = 3;

export const ACTION_KEYS = [
    "sales_ready",
    "hot_not_called",
    "visit_overdue",
    "quotes_no_answer",
    "said_yes",
    "onboarding_stalled",
    "won_without_quote",
    "hot_aged",
] as const;
export type ActionKey = (typeof ACTION_KEYS)[number];

export const ACTION_TITLES: Record<ActionKey, string> = {
    sales_ready: "Sales-ready leads with no owner",
    hot_not_called: "Hot leads not called in time",
    visit_overdue: "Waiting for a field visit",
    quotes_no_answer: "Quotes with no answer",
    said_yes: "Dealer said yes, not marked Won",
    onboarding_stalled: "Onboarding stalled",
    won_without_quote: "Won without an approved quote",
    hot_aged: "Hot leads open more than 7 days",
};

export type Team = "all" | "field" | "inside";
export type ActionScope = { state?: string | null; ownerId?: string | null; team?: Team };

export type ActionRow = {
    lead_id: string;
    dealer: string;
    city: string | null;
    state: string | null;
    owner_name: string | null;
    /** The person shown in the owner column (the ASM on field visits) — the Person filter. */
    owner_id: string | null;
    /** One line on why the lead is here. */
    detail: string;
    /** ₹ where the tile is about money (quotes, said yes). */
    value: number | null;
};

export type ActionTileData = { count: number; sub: string };
export type ActionSummary = Record<ActionKey, ActionTileData | null>;

const FIELD_ROLES = ["asm", "sales_manager"];
const INSIDE_ROLES = ["inside_sales_rep"];
const rolesOf = (team: Team | undefined) => (team === "field" ? FIELD_ROLES : team === "inside" ? INSIDE_ROLES : null);

const WORKABLE = sql.raw(WORKABLE_STATUSES.map((s) => `'${s}'`).join(", "));
const NAME = sql`COALESCE(dl.shop_name, dl.dealer_name, '(unnamed)')`;
const IST_DAY = (at: SQL) => sql`TO_CHAR((${at}) AT TIME ZONE 'Asia/Kolkata', 'DD Mon')`;
const WORKING_DAYS_SINCE = (at: SQL) => sql`(
    SELECT COUNT(*) FROM generate_series(
        ((${at}) AT TIME ZONE 'Asia/Kolkata')::date + 1,
        (now() AT TIME ZONE 'Asia/Kolkata')::date, INTERVAL '1 day'
    ) gs WHERE EXTRACT(DOW FROM gs) <> 0
)::int`;

/**
 * The page's filters on `dl`. `holder` is who the person / team filters look
 * at: the lead's owner, or (field visits) the ASM as well. A tile about leads
 * with no owner takes the state filter only.
 */
function scope(s: ActionScope, holder: "owner" | "owner_or_asm" | "none"): SQL {
    const parts: SQL[] = [];
    if (s.state) parts.push(sql`lower(trim(dl.state)) = lower(trim(${s.state}))`);
    if (holder !== "none") {
        const cols = holder === "owner_or_asm" ? [sql`dl.current_owner_id`, sql`dl.asm_id`] : [sql`dl.current_owner_id`];
        if (s.ownerId) parts.push(sql`(${sql.join(cols.map((c) => sql`${c} = ${s.ownerId}`), sql` OR `)})`);
        const roles = rolesOf(s.team);
        if (roles) {
            const list = sql.raw(roles.map((r) => `'${r}'`).join(", "));
            parts.push(sql`EXISTS (SELECT 1 FROM users ur
                WHERE ur.role IN (${list}) AND (${sql.join(cols.map((c) => sql`ur.id::text = ${c}`), sql` OR `)}))`);
        }
    }
    return parts.length ? sql` AND ${sql.join(parts, sql` AND `)}` : sql``;
}

type Raw = Record<string, unknown>;
const run = async (q: SQL) => (await db.execute(q)) as unknown as Raw[];
const str = (v: unknown) => (v == null ? null : String(v));
const base = (r: Raw, detail: string, value: number | null = null): ActionRow => ({
    lead_id: String(r.lead_id),
    dealer: String(r.dealer),
    city: str(r.city),
    state: str(r.state),
    owner_name: str(r.owner_name),
    owner_id: str(r.owner_id),
    detail,
    value,
});

const inr = (n: number) =>
    n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(2)} L` : `₹${Math.round(n).toLocaleString("en-IN")}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── Rows per tile ───────────────────────────────────────────────────────────

type Built = { rows: ActionRow[]; sub: string };

async function salesReady(s: ActionScope): Promise<Built> {
    const raw = await run(sql`
        SELECT dl.id AS lead_id, ${NAME} AS dealer, dl.city, dl.state, NULL AS owner_name, NULL AS owner_id,
               ${daysAwaitingAssignment()} AS days, dl.interest_level
          FROM dealer_leads dl
         WHERE ${awaitingAssignment()} ${scope(s, "none")}
         ORDER BY days DESC NULLS LAST`);
    const rows = raw.map((r) =>
        base(r, `Waiting ${plural(Number(r.days ?? 0), "day")}${r.interest_level ? ` · ${String(r.interest_level)}` : ""}`),
    );
    const oldest = raw.length ? Math.max(...raw.map((r) => Number(r.days ?? 0))) : 0;
    const hot = raw.filter((r) => String(r.interest_level ?? "").toLowerCase() === "hot").length;
    return { rows, sub: `Oldest waiting ${plural(oldest, "day")} · ${hot} Hot` };
}

async function hotNotCalled(s: ActionScope): Promise<Built> {
    const raw = await run(sql`
        SELECT dl.id AS lead_id, ${NAME} AS dealer, dl.city, dl.state, u.name AS owner_name, u.id::text AS owner_id,
               COALESCE(dl.assigned_at, dl.created_at) AS since
          FROM dealer_leads dl
          LEFT JOIN users u ON u.id::text = dl.current_owner_id
         WHERE lower(dl.interest_level) = 'hot'
           AND dl.is_active IS NOT FALSE
           AND dl.lead_status IN (${WORKABLE}) AND dl.lead_status <> 'Transferred_to_ASM'
           AND dl.current_owner_id IS NOT NULL
           AND (to_jsonb(dl) ->> 'contactability') IS NULL
           AND NOT EXISTS (SELECT 1 FROM lead_touchpoints t
                WHERE t.dealer_lead_id = dl.id AND t.touchpoint_type IN ('inside_sales_call', 'visit')
                  AND t.performed_at >= COALESCE(dl.assigned_at, dl.created_at))
           ${scope(s, "owner")}`);
    const now = new Date();
    const late = raw
        .map((r) => ({ r, hours: workingHoursBetween(new Date(String(r.since)), now) }))
        .filter((x) => x.hours > HOT_FIRST_CALL_LIMIT_HOURS)
        .sort((a, b) => b.hours - a.hours);
    const rows = late.map(({ r, hours }) =>
        base(r, `With owner since ${new Date(String(r.since)).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" })} · ${Math.floor(hours)} working hours, no call or visit`),
    );
    return { rows, sub: `Past the ${HOT_FIRST_CALL_LIMIT_HOURS}-working-hour first-attempt limit` };
}

async function visitOverdue(s: ActionScope): Promise<Built> {
    const [raw, limit] = await Promise.all([
        run(sql`
            SELECT dl.id AS lead_id, ${NAME} AS dealer, dl.city, dl.state,
                   COALESCE(a.name, u.name) AS owner_name,
                   COALESCE(a.id::text, u.id::text) AS owner_id,
                   ${IST_DAY(sql.raw(TRANSFER_AT_EXPR))} AS transferred_on,
                   ${TRANSFER_WORKING_DAYS_SQL} AS days
              FROM dealer_leads dl
              LEFT JOIN users a ON a.id::text = dl.asm_id
              LEFT JOIN users u ON u.id::text = dl.current_owner_id
             WHERE ${TRANSFER_VISIT_OVERDUE_SQL} ${scope(s, "owner_or_asm")}
             ORDER BY days DESC`),
        getAsmTransferVisitLimit(),
    ]);
    const rows = raw.map((r) => base(r, `Transferred ${String(r.transferred_on)} · ${plural(Number(r.days), "working day")}, no visit`));
    const byCity = new Map<string, number>();
    for (const r of rows) {
        const c = r.city?.trim() || "Unknown city";
        byCity.set(c, (byCity.get(c) ?? 0) + 1);
    }
    const top = [...byCity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c, n]) => `${c} ${n}`).join(", ");
    return { rows, sub: `Over ${plural(limit.days, "working day")} since transfer${top ? ` · ${top}` : ""}` };
}

async function quotesNoAnswer(s: ActionScope): Promise<Built> {
    const raw = await run(sql`
        SELECT dl.id AS lead_id, ${NAME} AS dealer, dl.city, dl.state, u.name AS owner_name, u.id::text AS owner_id,
               q.quote_number, q.value, ${IST_DAY(sql`d.sent_at`)} AS sent_on,
               ${WORKING_DAYS_SINCE(sql`d.sent_at`)} AS days
          FROM dealer_leads dl
          LEFT JOIN users u ON u.id::text = dl.current_owner_id
          CROSS JOIN LATERAL (
              SELECT c.commercial_id, c.quote_number, c.dealer_decision, c.withdrawn_at,
                     COALESCE(CASE WHEN (c.quote_snapshot ->> 'total') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                                   THEN (c.quote_snapshot ->> 'total')::numeric END,
                              c.final_price, c.price_quoted, 0) AS value
                FROM dealer_lead_commercials c
               WHERE c.dealer_lead_id = dl.id AND c.event_type IN ('quote_issue', 'quote_revision')
               ORDER BY c.version_no DESC
               LIMIT 1
          ) q
          CROSS JOIN LATERAL (
              SELECT MAX(x.created_at) AS sent_at FROM quotation_dispatches x
               WHERE x.commercial_id = q.commercial_id AND x.status = 'sent'
          ) d
         WHERE dl.is_active IS NOT FALSE
           AND dl.lead_status IN (${WORKABLE})
           AND q.dealer_decision IS NULL AND q.withdrawn_at IS NULL
           AND d.sent_at IS NOT NULL
           AND ${WORKING_DAYS_SINCE(sql`d.sent_at`)} > ${QUOTE_NO_ANSWER_WORKING_DAYS}
           ${scope(s, "owner")}
         ORDER BY days DESC`);
    const rows = raw.map((r) =>
        base(
            r,
            `${r.quote_number ? `${String(r.quote_number)} · ` : ""}sent ${String(r.sent_on)} · ${plural(Number(r.days), "working day")}, no answer`,
            Number(r.value ?? 0),
        ),
    );
    const total = rows.reduce((a, r) => a + (r.value ?? 0), 0);
    return { rows, sub: `Delivered over ${QUOTE_NO_ANSWER_WORKING_DAYS} working days ago · ${inr(total)} quoted` };
}

async function saidYes(s: ActionScope): Promise<Built> {
    const roles = rolesOf(s.team);
    const all = await listSaidYesNotWon();
    const kept = all
        .filter((r) => !s.state || (r.state ?? "").trim().toLowerCase() === s.state.trim().toLowerCase())
        .filter((r) => !s.ownerId || r.owner_id === s.ownerId)
        .filter((r) => !roles || roles.includes((r.owner_role ?? "").toLowerCase()))
        .sort((a, b) => b.working_days_waiting - a.working_days_waiting);
    const rows = kept.map((r) =>
        base(
            { lead_id: r.lead_id, dealer: r.dealer, city: r.city, state: r.state, owner_name: r.owner_name, owner_id: r.owner_id },
            `${r.quote_number ? `${r.quote_number} · ` : ""}dealer said yes ${plural(r.working_days_waiting, "working day")} ago`,
            r.value,
        ),
    );
    const total = rows.reduce((a, r) => a + (r.value ?? 0), 0);
    const oldest = kept.length ? kept[0].working_days_waiting : 0;
    return { rows, sub: `${inr(total)} · oldest ${plural(oldest, "working day")}` };
}

async function onboardingStalled(s: ActionScope): Promise<Built> {
    const raw = await run(sql`
        SELECT dl.id AS lead_id, COALESCE(dl.shop_name, dl.dealer_name, oa.company_name, '(unnamed)') AS dealer,
               dl.city, dl.state, u.name AS owner_name, u.id::text AS owner_id,
               ${ONB_WAITING_ON} AS waiting_on, oa.onboarding_status,
               ${IST_DAY(sql.raw(ONB_LAST))} AS idle_since
          FROM dealer_leads dl
          JOIN dealer_onboarding_applications oa ON oa.id = dl.dealer_onboarding_application_id
          LEFT JOIN users u ON u.id::text = dl.current_owner_id
         WHERE ${ONBOARDING_STALLED} ${scope(s, "owner")}
         ORDER BY ${sql.raw(ONB_LAST)} ASC`);
    const rows = raw.map((r) =>
        base(
            r,
            `Waiting on ${r.waiting_on === "dealer" ? "the dealer" : "us"} · ${String(r.onboarding_status ?? "").replace(/_/g, " ")} · idle since ${String(r.idle_since)}`,
        ),
    );
    const dealer = raw.filter((r) => r.waiting_on === "dealer").length;
    return { rows, sub: `${dealer} waiting on the dealer · ${raw.length - dealer} waiting on us` };
}

async function wonWithoutQuote(s: ActionScope): Promise<Built> {
    const wonAt = sql`(to_jsonb(dl) ->> 'won_at')::timestamptz`;
    const raw = await run(sql`
        SELECT dl.id AS lead_id, ${NAME} AS dealer, dl.city, dl.state, u.name AS owner_name, u.id::text AS owner_id,
               dl.lead_status, ${IST_DAY(wonAt)} AS won_on
          FROM dealer_leads dl
          LEFT JOIN users u ON u.id::text = dl.current_owner_id
         WHERE ${WON_WITHOUT_QUOTE}
           AND (${wonAt} AT TIME ZONE 'Asia/Kolkata')::date
               >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date
           ${scope(s, "owner")}
         ORDER BY ${wonAt} DESC NULLS LAST`);
    const rows = raw.map((r) =>
        base(r, `${String(r.lead_status ?? "").replace(/_/g, " ")} on ${String(r.won_on ?? "—")} · no dealer-approved quote`),
    );
    return { rows, sub: "This month · check the price before onboarding" };
}

async function hotAged(s: ActionScope): Promise<Built> {
    const raw = await run(sql`
        SELECT * FROM (
            SELECT dl.id AS lead_id, ${NAME} AS dealer, dl.city, dl.state, u.name AS owner_name, u.id::text AS owner_id, dl.lead_status,
                   ((now() AT TIME ZONE 'Asia/Kolkata')::date
                    - (COALESCE(dl.interest_changed_at, dl.created_at) AT TIME ZONE 'Asia/Kolkata')::date) AS age,
                   ${IST_DAY(sql`COALESCE(dl.interest_changed_at, dl.created_at)`)} AS hot_since
              FROM dealer_leads dl
              LEFT JOIN users u ON u.id::text = dl.current_owner_id
             WHERE dl.interest_level = 'hot'
               AND dl.is_active IS NOT FALSE
               AND dl.lead_status IS DISTINCT FROM 'Converted'
               AND dl.lead_status IS DISTINCT FROM 'Lost'
               ${scope(s, "owner")}
        ) x
         WHERE x.age > 7
         ORDER BY x.age DESC`);
    const rows = raw.map((r) =>
        base(
            r,
            `Hot since ${String(r.hot_since)} · ${plural(Number(r.age), "day")} · ${r.lead_status ? String(r.lead_status).replace(/_/g, " ") : "not in sales yet"}`,
        ),
    );
    const over30 = raw.filter((r) => Number(r.age) > 30).length;
    return { rows, sub: `${over30} older than 30 days` };
}

const BUILDERS: Record<ActionKey, (s: ActionScope) => Promise<Built>> = {
    sales_ready: salesReady,
    hot_not_called: hotNotCalled,
    visit_overdue: visitOverdue,
    quotes_no_answer: quotesNoAnswer,
    said_yes: saidYes,
    onboarding_stalled: onboardingStalled,
    won_without_quote: wonWithoutQuote,
    hot_aged: hotAged,
};

/** Every row behind one tile, most urgent first. */
export async function listSalesHeadAction(key: ActionKey, s: ActionScope): Promise<ActionRow[]> {
    return (await BUILDERS[key](s)).rows;
}

/** All seven tiles; a tile whose source fails on this database is null. */
export async function salesHeadActionSummary(s: ActionScope): Promise<ActionSummary> {
    const built = await Promise.all(
        ACTION_KEYS.map(async (k) => {
            try {
                const b = await BUILDERS[k](s);
                return [k, { count: b.rows.length, sub: b.sub }] as const;
            } catch (e) {
                console.warn(`[salesHeadActions] ${k} skipped:`, e instanceof Error ? e.message : e);
                return [k, null] as const;
            }
        }),
    );
    return Object.fromEntries(built) as ActionSummary;
}

/** Parse the page's URL filters (same keys as the sales dashboard). */
export function actionScopeFrom(p: URLSearchParams): ActionScope {
    const team = p.get("team");
    return {
        state: p.get("state")?.trim() || null,
        ownerId: p.get("spoc_id")?.trim() || null,
        team: team === "field" || team === "inside" ? team : "all",
    };
}

/** The list page's free-text search: dealer, city, state, owner or the reason line. */
export function searchActionRows(rows: ActionRow[], q: string | null | undefined): ActionRow[] {
    const needle = (q ?? "").trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) =>
        [r.dealer, r.city, r.state, r.owner_name, r.detail].some((v) => (v ?? "").toLowerCase().includes(needle)),
    );
}

/** One tile's rows for the list page and its CSV — the same filters for both. */
export async function listSalesHeadActionFiltered(key: ActionKey, p: URLSearchParams): Promise<ActionRow[]> {
    return searchActionRows(await listSalesHeadAction(key, actionScopeFrom(p)), p.get("q"));
}

export const ACTION_CSV_COLUMNS: Array<{ header: string; value: (r: ActionRow) => string }> = [
    { header: "Lead ID", value: (r) => r.lead_id },
    { header: "Dealer", value: (r) => r.dealer },
    { header: "City", value: (r) => r.city ?? "" },
    { header: "State", value: (r) => r.state ?? "" },
    { header: "Owner", value: (r) => r.owner_name ?? "" },
    { header: "Why it is here", value: (r) => r.detail },
    { header: "Value (Rs)", value: (r) => (r.value == null ? "" : String(Math.round(r.value))) },
];
