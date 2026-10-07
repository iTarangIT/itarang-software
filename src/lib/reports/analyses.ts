// Reports › Analyses — the three look-back analyses on the Sales Head Reports
// page (redesign of 6 Oct 2026). SERVER ONLY. Types, catalogue and pure helpers
// are in analysesShared.ts.
//
// TIME ZONE. The business runs on IST, and the columns are not all alike:
//   dealer_leads.created_at        timestamp WITHOUT time zone, holding UTC  → istDay()
//   closed_at / won_at / assigned_at timestamp WITH time zone              → istDayTz()
//   lead_visits dates              plain `date`, already IST days       → compared as-is
// Using the wrong one moves every lead closed 00:00–10:59 IST to the day before.
//
// E-314 COLUMNS (source_door, source_origin, acquisition_campaign_id, won_at)
// are not in schema.ts. They are read through to_jsonb(dl) so a database
// without the migration reads NULL ("Not recorded") instead of failing.

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { countLeadsForExport } from "@/lib/admin/leadsExport";
import { buildSalesDashboard, OPEN_VISIT, SALES_DASHBOARD_MAX_DAYS, VISIT_KEY } from "@/lib/admin/salesDashboard";
import { isUndefinedColumn } from "@/lib/admin/reportHelpers";
import { capabilitiesFor } from "@/lib/leads/access";
import { parseLeadListFilters } from "@/lib/leads/leadListParams";
import { doorLabel, originLabel } from "@/lib/leads/leadSourceVocab";
import { TEAM_ROLES } from "@/lib/exports/datasets/types";
import { humanCall } from "@/lib/reports/metricDefinitions";
import {
    AI_BANDS,
    AI_NOT_SCORED,
    checkRows,
    type AiScoreResult,
    type AiScoreRow,
    type AnalysisPeriod,
    type LeadSourceGroup,
    type LeadSourceRow,
    type LeadSourcesResult,
    type MeetingRow,
    type MeetingsResult,
} from "./analysesShared";

type SessionUser = Awaited<ReturnType<typeof import("@/lib/auth-utils").requireAuth>>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const IST = "Asia/Kolkata";
const rowsOf = async <T>(q: SQL) => (await db.execute(q)) as unknown as T[];
const n = (v: unknown): number => Number(v ?? 0);

/** A UTC-without-zone timestamp column (dealer_leads.created_at) as its IST calendar day. */
const istDay = (col: SQL): SQL => sql`((${col}) AT TIME ZONE 'UTC' AT TIME ZONE ${IST})::date`;

/** A timestamptz column (closed_at, won_at …) as its IST calendar day. */
const istDayTz = (col: SQL): SQL => sql`((${col}) AT TIME ZONE ${IST})::date`;

/**
 * With sales: in the sales lifecycle AND someone holds it now, or held it when
 * it closed. A lead reactivated back into the pool keeps its old assigned_at
 * but has no owner — it sits in Ready to Assign, so it is NOT with sales.
 */
const WITH_SALES = sql`(dl.lead_status IS NOT NULL AND (dl.current_owner_id IS NOT NULL OR dl.closing_owner_id IS NOT NULL))`;

/** A lead's city as the Meetings rows show it; a blank city is its own row. */
// Case-insensitive like the Ops dashboard's city filter, so "nashik" and "Nashik" are one row.
const CITY = sql`COALESCE(INITCAP(LOWER(NULLIF(TRIM(dl.city), ''))), 'Unknown city')`;

export interface AnalysisFilters {
    from?: string | null;
    to?: string | null;
    group?: LeadSourceGroup;
    /** field | inside — the current owner's team. */
    team?: string | null;
    state?: string | null;
    /** A door code (AI score's Source filter). */
    source?: string | null;
    manager?: string | null;
    city?: string | null;
}

/**
 * The period, as inclusive IST days. Default: the last 90 days for the two
 * look-backs, month to date for Meetings. "Today" comes from Postgres in IST,
 * never from the Node clock.
 */
async function resolvePeriod(f: AnalysisFilters, fallback: "last90" | "mtd"): Promise<AnalysisPeriod> {
    const [t] = await rowsOf<{ today: string; start: string }>(sql`
        SELECT (now() AT TIME ZONE ${IST})::date::text AS today,
               ${fallback === "mtd"
                   ? sql`date_trunc('month', (now() AT TIME ZONE ${IST})::date)::date::text`
                   : sql`((now() AT TIME ZONE ${IST})::date - 89)::text`} AS start
    `);
    const from = f.from && ISO_DATE.test(f.from) ? f.from : t.start;
    const to = f.to && ISO_DATE.test(f.to) ? f.to : t.today;
    return from <= to ? { from, to } : { from: to, to: from };
}

const inPeriod = (day: SQL, p: AnalysisPeriod): SQL => sql`${day} BETWEEN ${p.from}::date AND ${p.to}::date`;

/**
 * The team of the lead's person: who holds it now, else who held it when it
 * closed (conversions are credited to the closing owner everywhere else). A
 * lead nobody has held belongs to no team, so a team filter leaves it out.
 */
function teamCond(team: string | null | undefined): SQL {
    const role = TEAM_ROLES[team ?? ""];
    if (!role) return sql``;
    return sql` AND EXISTS (SELECT 1 FROM users ou
                        WHERE ou.id::text = COALESCE(dl.current_owner_id, dl.closing_owner_id)::text
                          AND ou.role = ${role})`;
}

/** Same match as the Leads list and its download (leadListQuery.ts), so the two agree. */
const stateCond = (state: string | null | undefined): SQL =>
    state?.trim() ? sql` AND dl.state ILIKE ${`%${state.trim()}%`}` : sql``;

function lostReasonLabel(v: string | null): string | null {
    if (!v) return null;
    const s = v.replace(/_/g, " ");
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─────────────────────────────── Lead sources ──────────────────────────────

/*
 * One row per lead created in the period (active leads only — the same cohort
 * as the CEO funnel's "All leads created"), bucketed ONCE so the splits add up
 * by construction:
 *
 *   With sales   = WITH_SALES: in the sales lifecycle AND held by someone now
 *                  or when it closed. Shown as "Assigned".
 *   Not with sales yet = everything else: the AI-dialer pool (status NULL),
 *                  sales-ready or reactivated with nobody on it (Ready to
 *                  Assign), and leads closed before any salesperson had them.
 *
 *   Assigned splits into Converted | Lost | In onboarding (Won, waiting for the
 *   admin to approve the dealer) | Open (every other status).
 *
 * The step columns are flags on the same row:
 *   Called      with sales AND at least one human call — humanCall(), the
 *               metric-dictionary definition (AI dialer calls are not a
 *               rep's call).
 *   Quote sent  with sales AND a quote that REACHED the dealer: a successful
 *               dispatch (quotation_dispatches 'sent' or the quote_dispatched
 *               touchpoint) — Sales Daily's "Quotes delivered". A quote that
 *               was only approved is not sent.
 *   Marked won  with sales AND (won_at set, or Won / Converted — a lead
 *               converted before won_at existed has no won_at).
 *   Converted   lead_status = 'Converted' — metric M15, the one definition
 *               every report and email uses.
 */
export async function leadSources(f: AnalysisFilters, viewer: SessionUser): Promise<LeadSourcesResult> {
    const period = await resolvePeriod(f, "last90");
    const group: LeadSourceGroup = f.group ?? "door";
    const keyExpr =
        group === "origin" ? sql`c.origin` : group === "campaign" ? sql`c.campaign_id` : sql`c.door`;

    type Raw = {
        key: string | null;
        leads_in: string;
        not_with_sales: string;
        assigned: string;
        called: string;
        quote_sent: string;
        won: string;
        converted: string;
        open: string;
        onboarding: string;
        lost: string;
        top_lost_reason: string | null;
        origins: string;
        campaigns: string;
    };

    const raw = await rowsOf<Raw>(sql`
        WITH cohort AS (
            SELECT dl.id,
                   dl.lead_status,
                   dl.lost_reason,
                   to_jsonb(dl) ->> 'source_door'             AS door,
                   to_jsonb(dl) ->> 'source_origin'           AS origin,
                   to_jsonb(dl) ->> 'acquisition_campaign_id' AS campaign_id,
                   ${WITH_SALES} AS with_sales,
                   (${WITH_SALES} AND ((to_jsonb(dl) ->> 'won_at') IS NOT NULL
                                       OR dl.lead_status IN ('Won', 'Converted'))) AS won
              FROM dealer_leads dl
             WHERE dl.is_active IS NOT FALSE
               AND ${inPeriod(istDay(sql`dl.created_at`), period)}
               ${teamCond(f.team)}
               ${stateCond(f.state)}
        ),
        c AS (
            SELECT cohort.*,
                   cohort.with_sales AND EXISTS (
                       SELECT 1 FROM lead_touchpoints t
                        WHERE t.dealer_lead_id = cohort.id AND ${humanCall(sql`t`)}
                   ) AS called,
                   cohort.with_sales AND (
                       EXISTS (
                           SELECT 1 FROM lead_touchpoints t
                            WHERE t.dealer_lead_id = cohort.id
                              AND t.touchpoint_type = 'quote_dispatched'
                       )
                       OR EXISTS (
                           SELECT 1 FROM quotation_dispatches qd
                            WHERE qd.dealer_lead_id = cohort.id AND qd.status = 'sent'
                       )
                   ) AS quote_sent
              FROM cohort
        )
        SELECT ${keyExpr} AS key,
               COUNT(*)::text                                                            AS leads_in,
               COUNT(*) FILTER (WHERE NOT c.with_sales)::text                            AS not_with_sales,
               COUNT(*) FILTER (WHERE c.with_sales)::text                                AS assigned,
               COUNT(*) FILTER (WHERE c.called)::text                                    AS called,
               COUNT(*) FILTER (WHERE c.quote_sent)::text                                AS quote_sent,
               COUNT(*) FILTER (WHERE c.won)::text                                       AS won,
               COUNT(*) FILTER (WHERE c.with_sales AND c.lead_status = 'Converted')::text AS converted,
               COUNT(*) FILTER (WHERE c.with_sales
                                  AND c.lead_status NOT IN ('Converted', 'Lost', 'Won'))::text AS open,
               COUNT(*) FILTER (WHERE c.with_sales AND c.lead_status = 'Won')::text       AS onboarding,
               COUNT(*) FILTER (WHERE c.with_sales AND c.lead_status = 'Lost')::text      AS lost,
               mode() WITHIN GROUP (ORDER BY c.lost_reason)
                   FILTER (WHERE c.with_sales AND c.lead_status = 'Lost' AND c.lost_reason IS NOT NULL) AS top_lost_reason,
               COUNT(DISTINCT c.origin)::text                                            AS origins,
               COUNT(DISTINCT c.campaign_id)::text                                       AS campaigns
          FROM c
         GROUP BY ${keyExpr}
         ORDER BY COUNT(*) DESC
    `);

    // Labels for campaigns, in one query.
    const campaignNames = new Map<string, { name: string; kind: string | null }>();
    if (group === "campaign") {
        const ids = raw.map((r) => r.key).filter((k): k is string => !!k);
        if (ids.length > 0) {
            try {
                const names = await rowsOf<{ id: string; name: string; kind: string | null }>(sql`
                    SELECT id::text AS id, name, kind FROM acquisition_campaigns
                     WHERE id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
                `);
                for (const r of names) campaignNames.set(r.id, { name: r.name, kind: r.kind });
            } catch (e) {
                console.warn("[analyses/lead_sources] campaign names unavailable:", (e as Error).message.split("\n")[0]);
            }
        }
    }

    const toRow = (r: Raw): LeadSourceRow => {
        const origins = n(r.origins);
        const campaigns = n(r.campaigns);
        let label: string;
        let sub: string;
        if (r.key == null) {
            label = "Not recorded";
            sub = group === "campaign" ? "No campaign on the lead" : "Created before sources were recorded";
        } else if (group === "door") {
            label = doorLabel(r.key) ?? r.key;
            sub = `${origins} ${origins === 1 ? "origin" : "origins"}${campaigns ? ` · ${campaigns} ${campaigns === 1 ? "campaign" : "campaigns"}` : ""}`;
        } else if (group === "origin") {
            label = originLabel(r.key) ?? r.key;
            sub = campaigns ? `${campaigns} ${campaigns === 1 ? "campaign" : "campaigns"}` : "No campaign";
        } else {
            const c = campaignNames.get(r.key);
            label = c?.name ?? `Campaign ${r.key.slice(0, 8)}`;
            sub = c?.kind ? c.kind.replace(/_/g, " ") : "";
        }
        return {
            key: r.key,
            label,
            sub,
            leads_in: n(r.leads_in),
            not_with_sales: n(r.not_with_sales),
            assigned: n(r.assigned),
            called: n(r.called),
            quote_sent: n(r.quote_sent),
            won: n(r.won),
            converted: n(r.converted),
            open: n(r.open),
            onboarding: n(r.onboarding),
            lost: n(r.lost),
            top_lost_reason: lostReasonLabel(r.top_lost_reason),
        };
    };

    const rows = raw.map(toRow);

    // The total is summed from the rows (every lead sits in exactly one group,
    // NULL included) — except the top lost reason, which is a mode and has to
    // be re-taken over all lost leads, not picked from the rows.
    const sum = (k: keyof LeadSourceRow) => rows.reduce((s, r) => s + (r[k] as number), 0);
    const [topAll] = await rowsOf<{ r: string | null }>(sql`
        SELECT mode() WITHIN GROUP (ORDER BY dl.lost_reason) AS r
          FROM dealer_leads dl
         WHERE dl.is_active IS NOT FALSE
           AND dl.lead_status = 'Lost' AND dl.lost_reason IS NOT NULL
           AND ${WITH_SALES}
           AND ${inPeriod(istDay(sql`dl.created_at`), period)}
           ${teamCond(f.team)}
           ${stateCond(f.state)}
    `);
    const total: LeadSourceRow = {
        key: "__all__",
        label: "All sources",
        sub: "Leads created in the period",
        leads_in: sum("leads_in"),
        not_with_sales: sum("not_with_sales"),
        assigned: sum("assigned"),
        called: sum("called"),
        quote_sent: sum("quote_sent"),
        won: sum("won"),
        converted: sum("converted"),
        open: sum("open"),
        onboarding: sum("onboarding"),
        lost: sum("lost"),
        top_lost_reason: lostReasonLabel(topAll?.r ?? null),
    };

    const all = [total, ...rows];
    const checks = [
        checkRows("Not with sales yet + Assigned = Leads in, on every row", all,
            (r) => r.not_with_sales + r.assigned === r.leads_in, (r) => r.label),
        checkRows("Open + In onboarding + Lost + Converted = Assigned, on every row", all,
            (r) => r.open + r.onboarding + r.lost + r.converted === r.assigned, (r) => r.label),
        checkRows("Called ≤ Assigned and Converted ≤ Marked won, on every row", all,
            (r) => r.called <= r.assigned && r.converted <= r.won, (r) => r.label),
    ];

    // "A download adds up to the analysis": All sources must equal the Leads
    // download for the same period and state, dead numbers included. The Leads
    // dataset has no team filter, so with a team set there is nothing to tie to.
    if (!f.team) {
        const p = new URLSearchParams({ from: period.from, to: period.to, contactability: "include" });
        if (f.state?.trim()) p.set("state", f.state.trim());
        const downloadCount = await countLeadsForExport(
            await parseLeadListFilters(p, capabilitiesFor(viewer.role), viewer),
        );
        checks.push({
            label: "All sources = the Leads download for the same period",
            holds: downloadCount === total.leads_in,
            detail: downloadCount === total.leads_in ? "" : `Breaks: the download has ${downloadCount} leads, this shows ${total.leads_in}.`,
        });
    }

    return { period, group, total, rows, checks };
}

// ───────────────────────────── AI score accuracy ───────────────────────────

/*
 * Leads that CLOSED in the period (Converted or Lost, by closed_at in IST),
 * by AI score band. final_intent_score defaults to 0, so a 0 with no AI band
 * is a lead the AI never scored — the rule the Leads download uses. Those go
 * to their own row; the old report put them in 0–20 and made the lowest band
 * look worse than it is.
 */
export async function aiScoreAccuracyByBand(f: AnalysisFilters): Promise<AiScoreResult> {
    const period = await resolvePeriod(f, "last90");
    const sourceCond = f.source ? sql` AND (to_jsonb(dl) ->> 'source_door') = ${f.source}` : sql``;
    const raw = await rowsOf<{ band: string; converted: string; lost: string }>(sql`
        SELECT band,
               COUNT(*) FILTER (WHERE lead_status = 'Converted')::text AS converted,
               COUNT(*) FILTER (WHERE lead_status = 'Lost')::text      AS lost
          FROM (
              SELECT dl.lead_status,
                     CASE
                         WHEN COALESCE(dl.final_intent_score, 0) <= 0 AND dl.intent_band IS NULL THEN ${AI_NOT_SCORED}
                         WHEN dl.final_intent_score <= 20 THEN '0-20'
                         WHEN dl.final_intent_score <= 40 THEN '21-40'
                         WHEN dl.final_intent_score <= 60 THEN '41-60'
                         WHEN dl.final_intent_score <= 80 THEN '61-80'
                         ELSE '81-100'
                     END AS band
                FROM dealer_leads dl
               WHERE dl.is_active IS NOT FALSE
                 AND dl.lead_status IN ('Converted', 'Lost')
                 AND dl.closed_at IS NOT NULL
                 AND ${inPeriod(istDayTz(sql`dl.closed_at`), period)}
                 ${teamCond(f.team)}
                 ${sourceCond}
          ) s
         GROUP BY band
    `);
    const byBand = new Map(raw.map((r) => [r.band, r]));
    const mk = (band: string, label: string): AiScoreRow => {
        const r = byBand.get(band);
        const converted = n(r?.converted);
        const lost = n(r?.lost);
        return { band, label, converted, lost, closed: converted + lost };
    };
    const rows = [...AI_BANDS.map((b) => mk(b, b.replace("-", "–"))), mk(AI_NOT_SCORED, "Not scored")];
    const total: AiScoreRow = {
        band: "all",
        label: "All closed leads",
        converted: rows.reduce((s, r) => s + r.converted, 0),
        lost: rows.reduce((s, r) => s + r.lost, 0),
        closed: rows.reduce((s, r) => s + r.closed, 0),
    };

    // Conversion must rise with the score: each scored band (high → low) must
    // convert at least as well as the band below it. Bands with nothing closed
    // say nothing and are skipped.
    const scored = rows.filter((r) => r.band !== AI_NOT_SCORED && r.closed > 0);
    const inversions: string[] = [];
    for (let i = 0; i + 1 < scored.length; i++) {
        const hi = scored[i];
        const lo = scored[i + 1];
        if (hi.converted / hi.closed < lo.converted / lo.closed) inversions.push(`${hi.label} below ${lo.label}`);
    }
    const checks = [
        {
            label: "Conversion rises with the score in every band",
            holds: inversions.length === 0,
            detail: inversions.length ? `Breaks: ${inversions.join("; ")}.` : "",
        },
        checkRows("Closed = Converted + Lost, on every row", [...rows, total],
            (r) => r.converted + r.lost === r.closed, (r) => r.label),
    ];
    return { period, rows, total, checks };
}


// ───────────────────────────────── Meetings ────────────────────────────────

/*
 * Field visits by person × city, counted EXACTLY as the Sales Head Ops
 * dashboard, the Sales Daily email and targets count them
 * (src/lib/admin/salesDashboard.ts — VISIT_KEY and OPEN_VISIT are imported
 * from there, not restated):
 *
 *   A visit   lead_visits row with actual_visit_date in the period, on a lead
 *             that exists; one person + one dealer + one day is ONE visit
 *             however many rows were logged.
 *   Fresh     a visit on the dealer's first-ever actual visit day (over the
 *             whole table, not only this period). Repeat = the other visits.
 *   Planned   rows still open (not visited / cancelled / no-show) whose
 *             planned date falls in the period.
 *
 * Planning rows are NOT meetings. Handing a lead to an ASM inserts a
 * `scheduled` row and logging the visit inserts a NEW `visited` row — nothing
 * ever closes the plan — so counting rows by "visit date, else planned date"
 * (the old report) counted most handovers twice.
 *
 * Every active ASM / sales manager is listed, with zeros when they had no
 * visits; anyone else with a visit or plan in the period is listed too,
 * marked inactive when deactivated.
 */
export async function meetingsByManagerCity(f: AnalysisFilters): Promise<MeetingsResult> {
    const period = await resolvePeriod(f, "mtd");

    type VisitRaw = {
        asm_id: string | null;
        city: string;
        visits: string;
        dealers: string;
        fresh: string;
        ground: string;
        calling: string;
        whatsapp: string;
        other_mode: string;
    };
    const visitsQuery = (modeCol: SQL) => sql`
        WITH fv AS (
            SELECT dealer_lead_id, MIN(actual_visit_date) AS first_d
              FROM lead_visits
             WHERE actual_visit_date IS NOT NULL
             GROUP BY dealer_lead_id
        ),
        vis AS (
            SELECT v.asm_id, v.dealer_lead_id, v.actual_visit_date,
                   ${CITY} AS city,
                   (v.actual_visit_date = fv.first_d) AS is_new,
                   ${modeCol} AS mode
              FROM lead_visits v
              JOIN dealer_leads dl ON dl.id = v.dealer_lead_id
              LEFT JOIN fv ON fv.dealer_lead_id = v.dealer_lead_id
             WHERE v.actual_visit_date BETWEEN ${period.from}::date AND ${period.to}::date
        ),
        -- One row per visit (person, dealer, day). Several rows logged for the
        -- same visit keep the first mode alphabetically, so the split is stable.
        visit AS (
            SELECT asm_id, dealer_lead_id, actual_visit_date,
                   MIN(city) AS city, BOOL_OR(is_new) AS is_new, MIN(mode) AS mode
              FROM vis
             GROUP BY ${VISIT_KEY}
        )
        SELECT asm_id, city,
               COUNT(*)::text                                  AS visits,
               COUNT(DISTINCT dealer_lead_id)::text            AS dealers,
               COUNT(*) FILTER (WHERE is_new)::text            AS fresh,
               COUNT(*) FILTER (WHERE mode = 'ground')::text   AS ground,
               COUNT(*) FILTER (WHERE mode = 'calling')::text  AS calling,
               COUNT(*) FILTER (WHERE mode = 'whatsapp')::text AS whatsapp,
               COUNT(*) FILTER (WHERE mode NOT IN ('ground', 'calling', 'whatsapp'))::text AS other_mode
          FROM visit
         GROUP BY asm_id, city
    `;
    let visitRows: VisitRaw[];
    try {
        visitRows = await rowsOf<VisitRaw>(visitsQuery(sql`COALESCE(v.meeting_mode, 'ground')`));
    } catch (e) {
        if (!isUndefinedColumn(e)) throw e;
        // E-220 not applied: every visit predates any other mode being recordable.
        console.warn("[analyses/meetings] lead_visits.meeting_mode absent — E-220 not applied");
        visitRows = await rowsOf<VisitRaw>(visitsQuery(sql`'ground'`));
    }

    const plannedRows = await rowsOf<{ asm_id: string | null; city: string; planned: string }>(sql`
        SELECT v.asm_id, ${CITY} AS city, COUNT(*)::text AS planned
          FROM lead_visits v
          JOIN dealer_leads dl ON dl.id = v.dealer_lead_id
         WHERE ${OPEN_VISIT}
           AND v.scheduled_date BETWEEN ${period.from}::date AND ${period.to}::date
         GROUP BY v.asm_id, ${CITY}
    `);

    // The people: every active field person, plus anyone with a visit or plan here.
    const seen = [...new Set([...visitRows, ...plannedRows].map((r) => r.asm_id).filter((x): x is string => !!x))];
    const people = await rowsOf<{ id: string; name: string | null; is_active: boolean | null }>(sql`
        SELECT id::text AS id, name, is_active
          FROM users
         WHERE (role IN ('asm', 'sales_manager') AND is_active IS TRUE)
            OR id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(seen)}::jsonb))
    `);
    const personOf = new Map(people.map((p) => [p.id, { name: p.name ?? "(no name)", inactive: p.is_active === false }]));

    const empty = (managerId: string | null, city: string): MeetingRow => {
        const p = managerId ? personOf.get(managerId) : undefined;
        return {
            manager_id: managerId,
            manager: p ? p.name : managerId ? "(unknown user)" : "(no person recorded)",
            inactive: p?.inactive ?? false,
            city,
            visits: 0,
            dealers: 0,
            fresh: 0,
            repeat: 0,
            planned: 0,
            ground: 0,
            calling: 0,
            whatsapp: 0,
        };
    };
    const byKey = new Map<string, MeetingRow>();
    const rowFor = (asm: string | null, city: string): MeetingRow => {
        const k = `${asm ?? ""}|${city}`;
        let r = byKey.get(k);
        if (!r) {
            r = empty(asm, city);
            byKey.set(k, r);
        }
        return r;
    };
    let otherMode = 0;
    for (const v of visitRows) {
        const r = rowFor(v.asm_id, v.city);
        r.visits = n(v.visits);
        r.dealers = n(v.dealers);
        r.fresh = n(v.fresh);
        r.repeat = r.visits - r.fresh;
        r.ground = n(v.ground);
        r.calling = n(v.calling);
        r.whatsapp = n(v.whatsapp);
        otherMode += n(v.other_mode);
    }
    for (const p of plannedRows) rowFor(p.asm_id, p.city).planned = n(p.planned);
    // A field person with nothing in the period still gets a row of zeros.
    const withRows = new Set([...byKey.values()].map((r) => r.manager_id));
    for (const p of people) if (!withRows.has(p.id)) rowFor(p.id, "—");

    const all = [...byKey.values()];
    const managers = [...new Map(all.filter((r) => r.manager_id).map((r) => [r.manager_id as string, r])).values()]
        .map((r) => ({ id: r.manager_id as string, name: r.manager, inactive: r.inactive }))
        .sort((a, b) => Number(a.inactive) - Number(b.inactive) || a.name.localeCompare(b.name));
    const cities = [...new Set(all.map((r) => r.city).filter((c) => c !== "—"))].sort((a, b) => a.localeCompare(b));

    const rows = all
        .filter((r) => (!f.manager || r.manager_id === f.manager) && (!f.city || r.city === f.city))
        .sort(
            (a, b) =>
                b.visits - a.visits ||
                b.planned - a.planned ||
                Number(a.inactive) - Number(b.inactive) ||
                a.manager.localeCompare(b.manager) ||
                a.city.localeCompare(b.city),
        );

    const sumOf = (k: "visits" | "fresh" | "repeat" | "planned" | "ground" | "calling" | "whatsapp") =>
        rows.reduce((s, r) => s + r[k], 0);
    const total: MeetingRow = {
        ...empty(null, f.city || "All cities"),
        manager: "All",
        visits: sumOf("visits"),
        fresh: sumOf("fresh"),
        repeat: sumOf("repeat"),
        planned: sumOf("planned"),
        ground: sumOf("ground"),
        calling: sumOf("calling"),
        whatsapp: sumOf("whatsapp"),
        // Different dealers across everyone shown: a dealer two people visited counts once.
        dealers: await countDealers(period, f),
    };

    const label = (r: MeetingRow) => `${r.manager} · ${r.city}`;
    const checks = [
        checkRows("Fresh + Repeat = Visits, on every row", [total, ...rows], (r) => r.fresh + r.repeat === r.visits, label),
        checkRows(
            "Ground + Calling + WhatsApp = Visits, on every row",
            [total, ...rows],
            (r) => r.ground + r.calling + r.whatsapp === r.visits,
            label,
        ),
    ];

    // The tie to the Ops dashboard, from its own builder. Its city filter cannot
    // express "Unknown city" and it takes at most a year, so those are not compared.
    const days = (Date.parse(period.to) - Date.parse(period.from)) / 86_400_000 + 1;
    if (f.city !== "Unknown city" && days <= SALES_DASHBOARD_MAX_DAYS) {
        const dash = await buildSalesDashboard({
            from: period.from,
            to: period.to,
            spoc_id: f.manager || null,
            city: f.city || null,
            granularity: "day",
        });
        const ok = dash.totals.visits === total.visits && dash.totals.unique_visits === total.dealers;
        checks.push({
            label: "Visits and dealers = the Ops dashboard for the same dates",
            holds: ok,
            detail: ok
                ? ""
                : `Breaks: the Ops dashboard has ${dash.totals.visits} visits / ${dash.totals.unique_visits} dealers, this shows ${total.visits} / ${total.dealers}.`,
        });
    }

    return {
        period,
        rows,
        total,
        checks,
        managers,
        cities,
        mode_not_captured: total.calling + total.whatsapp + otherMode === 0,
    };
}

/** Distinct dealers visited in the period under the same filters — the "All" row's Dealers. */
async function countDealers(period: AnalysisPeriod, f: AnalysisFilters): Promise<number> {
    const [r] = await rowsOf<{ n: string }>(sql`
        SELECT COUNT(DISTINCT v.dealer_lead_id)::text AS n
          FROM lead_visits v
          JOIN dealer_leads dl ON dl.id = v.dealer_lead_id
         WHERE v.actual_visit_date BETWEEN ${period.from}::date AND ${period.to}::date
           ${f.manager ? sql` AND v.asm_id = ${f.manager}` : sql``}
           ${f.city ? sql` AND ${CITY} = ${f.city}` : sql``}
    `);
    return n(r?.n);
}
