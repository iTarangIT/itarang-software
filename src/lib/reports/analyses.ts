// Reports › Analyses — the three look-back analyses on the Sales Head Reports
// page (redesign of 6 Oct 2026). SERVER ONLY. Types, catalogue and pure helpers
// are in analysesShared.ts.
//
// TIME ZONE. The business runs on IST. dealer_leads.created_at / closed_at are
// timestamps WITHOUT time zone holding UTC, so every period bound converts
// them to an IST calendar day first. lead_visits dates are plain `date`
// columns already entered as IST days and are compared as they are.
//
// E-314 COLUMNS (source_door, source_origin, acquisition_campaign_id, won_at)
// are not in schema.ts. They are read through to_jsonb(dl) so a database
// without the migration reads NULL ("Not recorded") instead of failing.

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { countLeadsForExport } from "@/lib/admin/leadsExport";
import { isUndefinedColumn } from "@/lib/admin/reportHelpers";
import { capabilitiesFor } from "@/lib/leads/access";
import { parseLeadListFilters } from "@/lib/leads/leadListParams";
import { doorLabel, originLabel } from "@/lib/leads/leadSourceVocab";
import { QUOTE_RELEASED_TYPES } from "@/lib/lifecycle/touchpointTypes";
import { TEAM_ROLES } from "@/lib/exports/datasets/types";
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

/** A UTC-without-zone timestamp column as its IST calendar day. */
const istDay = (col: SQL): SQL => sql`((${col}) AT TIME ZONE 'UTC' AT TIME ZONE ${IST})::date`;

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

/** The current owner's team. A lead with no owner belongs to no team. */
function teamCond(team: string | null | undefined): SQL {
    const role = TEAM_ROLES[team ?? ""];
    if (!role) return sql``;
    return sql` AND EXISTS (SELECT 1 FROM users ou WHERE ou.id::text = dl.current_owner_id::text AND ou.role = ${role})`;
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
 *   With sales   = in the sales lifecycle (lead_status set) AND has or had an
 *                  owner. Shown as "Assigned".
 *   Not with sales yet = everything else: the AI-dialer pool (status NULL),
 *                  sales-ready with nobody on it, and leads closed before any
 *                  salesperson had them.
 *
 *   Assigned splits into Converted | Lost | In onboarding (Won, waiting for the
 *   admin to approve the dealer) | Open (every other status).
 *
 * The step columns are flags on the same row:
 *   Called      with sales AND at least one human call (inside_sales_call
 *               touchpoint). Any such row means the lead was called: the
 *               NeoDove de-duplication in humanCall() only drops twins, it
 *               never removes the last call on a lead.
 *   Quote sent  with sales AND a quote released to the dealer (touchpoint
 *               quote_released / quote_sent) or a successful quote dispatch.
 *   Marked won  won_at set, or the lead is Won or Converted (a lead converted
 *               before won_at existed has no won_at).
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
                   (dl.lead_status IS NOT NULL
                    AND (dl.current_owner_id IS NOT NULL
                         OR dl.assigned_at IS NOT NULL
                         OR dl.closing_owner_id IS NOT NULL)) AS with_sales,
                   ((to_jsonb(dl) ->> 'won_at') IS NOT NULL
                    OR dl.lead_status IN ('Won', 'Converted')) AS won
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
                        WHERE t.dealer_lead_id = cohort.id
                          AND t.touchpoint_type = 'inside_sales_call'
                   ) AS called,
                   cohort.with_sales AND (
                       EXISTS (
                           SELECT 1 FROM lead_touchpoints t
                            WHERE t.dealer_lead_id = cohort.id
                              AND t.touchpoint_type IN (${sql.join(QUOTE_RELEASED_TYPES.map((q) => sql`${q}`), sql`, `)})
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
           AND (dl.current_owner_id IS NOT NULL OR dl.assigned_at IS NOT NULL OR dl.closing_owner_id IS NOT NULL)
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
                 AND ${inPeriod(istDay(sql`dl.closed_at`), period)}
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
 * One row per sales manager × city — the logic of the old "Meetings (MTD)"
 * report (src/lib/admin/reports.ts meetingsMtd), with the period in IST days
 * and an "All" row.
 *
 * Source is lead_visits, never call touchpoints. Meeting date = the visit
 * date, else the planned date. FRESH vs REPEAT ranks over ALL of the lead's
 * meetings, not only those in the period, so a dealer met many times before
 * never reads as fresh. City comes from the lead.
 */
export async function meetingsByManagerCity(f: AnalysisFilters): Promise<MeetingsResult> {
    const period = await resolvePeriod(f, "mtd");
    const cityExpr = sql`COALESCE(NULLIF(TRIM(dl.city), ''), 'Unknown city')`;

    type Raw = {
        manager_id: string | null;
        manager: string;
        city: string;
        meetings: string;
        done: string;
        fresh: string;
        repeat_count: string;
        ground: string;
        calling: string;
        whatsapp: string;
    };
    const build = (modeCol: SQL) => sql`
        WITH ranked AS (
            SELECT v.asm_id,
                   v.dealer_lead_id,
                   v.visit_status,
                   COALESCE(v.actual_visit_date, v.scheduled_date) AS meeting_date,
                   ${modeCol} AS mode,
                   ROW_NUMBER() OVER (
                       PARTITION BY v.dealer_lead_id
                       ORDER BY COALESCE(v.actual_visit_date, v.scheduled_date, v.created_at::date) NULLS LAST, v.created_at
                   ) AS meeting_seq
              FROM lead_visits v
        )
        SELECT r.asm_id                                                  AS manager_id,
               COALESCE(u.name, '(unknown)')                             AS manager,
               ${cityExpr}                                               AS city,
               COUNT(*)::text                                            AS meetings,
               COUNT(*) FILTER (WHERE r.visit_status = 'visited')::text  AS done,
               COUNT(*) FILTER (WHERE r.meeting_seq = 1)::text           AS fresh,
               COUNT(*) FILTER (WHERE r.meeting_seq > 1)::text           AS repeat_count,
               COUNT(*) FILTER (WHERE r.mode = 'ground')::text           AS ground,
               COUNT(*) FILTER (WHERE r.mode = 'calling')::text          AS calling,
               COUNT(*) FILTER (WHERE r.mode = 'whatsapp')::text         AS whatsapp
          FROM ranked r
          LEFT JOIN dealer_leads dl ON dl.id = r.dealer_lead_id
          LEFT JOIN users u ON u.id::text = r.asm_id
         WHERE ${inPeriod(sql`r.meeting_date`, period)}
         GROUP BY r.asm_id, u.name, ${cityExpr}
         ORDER BY COUNT(*) DESC, manager, city
    `;
    let raw: Raw[];
    try {
        raw = await rowsOf<Raw>(build(sql`COALESCE(v.meeting_mode, 'ground')`));
    } catch (e) {
        if (!isUndefinedColumn(e)) throw e;
        // E-220 not applied: every meeting predates any other mode being recordable.
        console.warn("[analyses/meetings] lead_visits.meeting_mode absent — E-220 not applied");
        raw = await rowsOf<Raw>(build(sql`'ground'`));
    }

    const all: MeetingRow[] = raw.map((r) => ({
        manager_id: r.manager_id,
        manager: r.manager,
        city: r.city,
        meetings: n(r.meetings),
        done: n(r.done),
        fresh: n(r.fresh),
        repeat: n(r.repeat_count),
        ground: n(r.ground),
        calling: n(r.calling),
        whatsapp: n(r.whatsapp),
    }));

    // The filter lists come from the whole period, so picking one value never
    // empties the other list.
    const managers = [...new Map(all.filter((r) => r.manager_id).map((r) => [r.manager_id!, r.manager])).entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const cities = [...new Set(all.map((r) => r.city))].sort((a, b) => a.localeCompare(b));

    const rows = all.filter(
        (r) => (!f.manager || r.manager_id === f.manager) && (!f.city || r.city === f.city),
    );

    const keys = ["meetings", "done", "fresh", "repeat", "ground", "calling", "whatsapp"] as const;
    const total: MeetingRow = {
        manager_id: null,
        manager: "All",
        city: "All cities",
        ...(Object.fromEntries(keys.map((k) => [k, rows.reduce((s, r) => s + r[k], 0)])) as Record<(typeof keys)[number], number>),
    };
    const name = (r: MeetingRow) => `${r.manager} · ${r.city}`;
    const checks = [
        checkRows("Fresh + Repeat = Meetings, on every row", [total, ...rows], (r) => r.fresh + r.repeat === r.meetings, name),
        checkRows("Ground + Calling + WhatsApp = Meetings, on every row", [total, ...rows],
            (r) => r.ground + r.calling + r.whatsapp === r.meetings, name),
    ];
    return { period, rows, total, checks, managers, cities };
}
