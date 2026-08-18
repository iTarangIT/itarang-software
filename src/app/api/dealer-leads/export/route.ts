// GET /api/dealer-leads/export — the Leads list, as a CSV, for the CURRENT FILTERS.
//
// WHY THIS EXISTS ALONGSIDE /api/admin/leads/bulk?action=export. That one takes
// an explicit `lead_ids` array, so it can only export what is selected — and a
// selection is capped at BULK_ID_CAP and has to be built first. The question
// this route answers is the one a sales head actually asks: "give me a sheet of
// everything matching what I am looking at." It therefore takes the SAME query
// params as the list and runs the SAME buildWhere(), so the CSV and the screen
// can never disagree about which leads matched.
//
// WHY THE COLUMNS ARE CALL-CENTRIC. This is a follow-up worksheet, not a data
// dump: who owns the lead, when it was last called, what was said, what the
// disposition was, and when it is due next. The two facts that make it useful —
// the last call's remarks and its outcome — live in `lead_touchpoints`, not on
// `dealer_leads`, and are fetched with ONE lateral rather than a per-row query.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { withErrorHandler } from "@/lib/api-utils";
import { LEADS_PAGE_ROLES, capabilitiesFor } from "@/lib/leads/access";
import {
    isIntentBucket,
    normalizeScoreRange,
    parseScoreBound,
} from "@/lib/leads/intentBucket";
import { isConnectStatus, isDispositionBucket } from "@/lib/leads/dispositions";
import { buildExportWhere, type LeadListFilters } from "@/lib/leads/leadListQuery";
import { IDLE_RANGES, isIdleRangeKey } from "@/lib/leads/idle";
import { neodoveTablesPresent } from "@/lib/leads/leadCampaign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A wide filter over a few thousand leads with a lateral join is comfortably
// inside this; the cap below is what actually bounds the work.
export const maxDuration = 60;

// Rows, not bytes. 20k rows of these columns is a handful of MB — large enough
// that no realistic filter is silently truncated, small enough that nobody can
// ask the database for the whole table as one CSV by accident. When it bites,
// it is REPORTED (see X-Export-Truncated) rather than quietly short-changing
// the sheet, which is the failure mode that makes an export untrustworthy.
const EXPORT_ROW_CAP = 20_000;

function csvEscape(v: unknown): string {
    if (v == null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Render a timestamp for a spreadsheet, in IST.
 *
 * `YYYY-MM-DD HH:mm` rather than an ISO string with a Z: Excel and Sheets both
 * parse this shape as a real datetime, while an ISO-8601 string lands as text
 * and cannot be sorted — which is the first thing anyone does to a follow-up
 * sheet. IST because every user of this CRM is in one timezone and a UTC
 * "last call" reads five and a half hours early.
 */
function fmtDateTime(v: unknown): string {
    if (!v) return "";
    const d = new Date(v as string);
    if (Number.isNaN(d.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

type Row = Record<string, unknown>;

const COLUMNS: { header: string; key: string; date?: boolean }[] = [
    { header: "Name", key: "dealer_name" },
    { header: "Shop", key: "shop_name" },
    { header: "Mobile Number", key: "phone" },
    { header: "City", key: "city" },
    { header: "State", key: "state" },
    { header: "Status", key: "lead_status" },
    { header: "Follow-up Owner", key: "owner_name" },
    { header: "ASM", key: "asm_name" },
    { header: "Last Call At", key: "last_call_at", date: true },
    { header: "Last Call By", key: "last_call_by" },
    { header: "Last Call Outcome", key: "last_call_status" },
    { header: "Call Disposition", key: "disposition" },
    { header: "Disposition Bucket", key: "disposition_bucket" },
    // Which system recorded it. With three writers now (NeoDove, the AI dialer,
    // an inside-sales rep) the first person who needs the split can pivot in a
    // spreadsheet instead of writing SQL and guessing.
    { header: "Disposition Source", key: "disposition_source" },
    // ── What the AI learned ──────────────────────────────────────────────
    // TWO columns, not five. One Yes/No column per info signal would push "Last
    // Call Discussion" — the column this sheet exists for — off the first
    // screen; a count plus the list of what was actually disclosed carries the
    // same information in a tenth of the width.
    { header: "AI Last Called At", key: "ai_last_called_at", date: true },
    { header: "AI Band", key: "ai_band" },
    { header: "AI Signals (0-5)", key: "ai_info_signals" },
    { header: "AI Signals Disclosed", key: "ai_signals_disclosed" },
    { header: "AI Callback Requested", key: "ai_callback" },
    { header: "Next Follow-up At", key: "next_follow_up_at", date: true },
    { header: "Last Call Discussion", key: "last_call_remarks" },
    { header: "Created At", key: "created_at", date: true },
];

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole([...LEADS_PAGE_ROLES]);
    const caps = capabilitiesFor(user.role);

    const searchParams = new URL(req.url).searchParams;
    const intentParam = searchParams.get("intent");
    const connectStatusParam = searchParams.get("connect_status");
    const bucketParam = searchParams.get("disposition_bucket");
    const idleParam = searchParams.get("idle");
    const idleRange = isIdleRangeKey(idleParam) ? IDLE_RANGES[idleParam] : null;
    const campaignParam = searchParams.get("campaign")?.trim() || null;
    const scoreRange = normalizeScoreRange(
        parseScoreBound(searchParams.get("score_min")),
        parseScoreBound(searchParams.get("score_max")),
    );
    const hasNeodoveTables = campaignParam ? await neodoveTablesPresent() : false;

    // Parsed EXACTLY as GET /api/dealer-leads parses it — including the
    // owner/ASM tiering, so a role that cannot see who owns a lead on screen
    // cannot filter by it here either and get the answer by inference.
    const filters: LeadListFilters = {
        status: searchParams.get("status") || null,
        intent: isIntentBucket(intentParam) ? intentParam : null,
        scoreMin: scoreRange.min,
        scoreMax: scoreRange.max,
        source: searchParams.get("source") || null,
        neodoveOnly: searchParams.get("neodove") === "1",
        // Same idle band and campaign filter as the list — this route exists so
        // the CSV and the screen can never disagree about which leads matched.
        idleMinDays: idleRange?.min ?? null,
        idleMaxDays: idleRange?.max ?? null,
        idleNeverTouched: searchParams.get("idle") === "never",
        campaign: campaignParam,
        hasNeodoveTables,
        state: searchParams.get("state")?.trim() || null,
        city: searchParams.get("city")?.trim() || null,
        search: searchParams.get("search")?.trim() || null,
        from: searchParams.get("from")?.trim() || null,
        to: searchParams.get("to")?.trim() || null,
        connectStatus: isConnectStatus(connectStatusParam) ? connectStatusParam : null,
        dispositionBucket: isDispositionBucket(bucketParam) ? bucketParam : null,
        // The AI filters too — this route exists so the CSV and the screen can
        // never disagree about which leads matched. The `ai` lateral below is
        // unconditional here (the columns are always exported), so the
        // predicates referencing it always resolve.
        aiCalled: ["connected", "attempted", "never"].includes(
            searchParams.get("ai_called") ?? "",
        )
            ? searchParams.get("ai_called")
            : null,
        aiBand: ["Qualified", "Warm", "Cold", "Disqualified"].includes(
            searchParams.get("ai_band") ?? "",
        )
            ? searchParams.get("ai_band")
            : null,
        signalsMin: (() => {
            const n = Number(searchParams.get("signals_min"));
            return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
        })(),
        callback: searchParams.get("callback") === "1",
        disposition: searchParams.get("disposition")?.trim() || null,
        ownerId: caps.canSeeOwnerAsm ? searchParams.get("owner_id") || null : null,
        asmId: caps.canSeeOwnerAsm ? searchParams.get("asm_id") || null : null,
    };

    const where = buildExportWhere(filters);

    const [{ n: total }] = (await db.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM dealer_leads dl WHERE ${where}
    `)) as unknown as { n: number }[];

    const rows = (await db.execute<Row>(sql`
        SELECT
            dl.dealer_name,
            dl.shop_name,
            dl.phone,
            dl.city,
            dl.state,
            dl.lead_status,
            ow.name  AS owner_name,
            asm.name AS asm_name,
            lc.performed_at AS last_call_at,
            lc.by_name      AS last_call_by,
            lc.call_status  AS last_call_status,
            -- WHAT WAS ACTUALLY SAID, not the machine summary around it.
            --
            -- remarksFor() writes NeoDove touchpoints as
            --   [NeoDove] Disposition: X · Stage: Y · Tag: Z · “the agent's words”
            -- Dropping that verbatim into a column headed "Last Call Discussion"
            -- gives you three facts that already have their own columns here and
            -- — when the telecaller typed nothing — a cell reading
            -- "Disposition: status code 6 · Stage: Cold", which is noise
            -- masquerading as a conversation. So: take the quoted words if there
            -- are any, blank the cell if the remark is nothing but metadata, and
            -- pass anything else (a rep's hand-written note) straight through.
            CASE
                WHEN lc.remarks ~ '“.+”'          THEN substring(lc.remarks from '“(.+)”')
                WHEN lc.remarks LIKE '[NeoDove]%' THEN NULL
                ELSE lc.remarks
            END AS last_call_remarks,
            -- The lead's own scheduled call wins; a per-touchpoint next action
            -- is the fallback, because only some flows set the former.
            COALESCE(dl.next_call_at, lc.next_action_at) AS next_follow_up_at,
            -- E-236 columns, read through to_jsonb: naming a column that does
            -- not exist fails at PARSE time, which would take the whole export
            -- down on a database without the migration instead of leaving two
            -- cells blank.
            to_jsonb(dl) ->> 'last_disposition'        AS disposition,
            to_jsonb(dl) ->> 'last_disposition_bucket' AS disposition_bucket,
            to_jsonb(dl) ->> 'last_disposition_source' AS disposition_source,
            ai.called_at        AS ai_last_called_at,
            ai.band             AS ai_band,
            -- BLANK, not 0, when nothing was extracted. "0/5" means the dealer
            -- disclosed nothing when asked; a call that was never scored is a
            -- different claim, and COALESCE(...,0) here would assert the first
            -- about 271 of 298 calls.
            CASE WHEN ai.signals IS NOT NULL
                 THEN COALESCE(ai.info_signals_count, 0)::text END AS ai_info_signals,
            ai.signals_disclosed AS ai_signals_disclosed,
            CASE WHEN ai.callback_agreed = 'yes' THEN 'Yes' END AS ai_callback,
            dl.created_at
        FROM dealer_leads dl
        LEFT JOIN users ow  ON ow.id::text  = dl.current_owner_id
        LEFT JOIN users asm ON asm.id::text = dl.asm_id
        -- Latest CALL, not latest touchpoint. A status-change note or an
        -- assignment carries no discussion, so letting one win would blank the
        -- most valuable column on the sheet. neodove_dial_request is excluded
        -- for the same reason it is excluded from the campaign counters: a
        -- hand-off request is not a conversation.
        LEFT JOIN LATERAL (
            SELECT t.performed_at,
                   t.call_status,
                   t.remarks,
                   t.next_action_at,
                   -- The 'ai_call' arm of the type filter below has matched
                   -- ZERO rows since it was written, because the AI dialer never
                   -- wrote a touchpoint. Now that it does, this column would go
                   -- BLANK on those rows — performed_by is null by design and
                   -- there is no external agent — next to a populated "Last Call
                   -- At", which reads as data loss rather than as a robot call.
                   COALESCE(
                       u.name,
                       to_jsonb(t) ->> 'external_agent_name',
                       CASE WHEN t.touchpoint_type = 'ai_call' THEN 'AI Dialer' END
                   ) AS by_name
              FROM lead_touchpoints t
              LEFT JOIN users u ON u.id::text = t.performed_by
             WHERE t.dealer_lead_id = dl.id
               AND t.touchpoint_type IN ('ai_call', 'inside_sales_call')
             ORDER BY t.performed_at DESC
             LIMIT 1
        ) lc ON true
        LEFT JOIN LATERAL (
            SELECT a.band,
                   a.info_signals_count,
                   a.signals,
                   COALESCE(a.ended_at, a.created_at) AS called_at,
                   a.signals ->> 'callback_agreed'    AS callback_agreed,
                   (SELECT string_agg(s.k, ', ' ORDER BY s.k)
                      FROM jsonb_each_text(a.signals) AS s(k, v)
                     WHERE s.v = 'yes'
                       AND s.k IN ('battery_spec_shared','volume_shared',
                                   'existing_financier_shared','financing_need_expressed',
                                   'financing_value_acknowledged')) AS signals_disclosed
              FROM ai_call_logs a
             WHERE a.lead_id = dl.id
             ORDER BY a.created_at DESC
             LIMIT 1
        ) ai ON true
        WHERE ${where}
        ORDER BY dl.last_touchpoint_at DESC NULLS LAST, dl.created_at DESC
        LIMIT ${EXPORT_ROW_CAP}
    `)) as unknown as Row[];

    // Owner and ASM are oversight-only. Blanked rather than omitted so the
    // column layout is identical for every role — a sheet whose columns shift
    // by who downloaded it cannot be pasted into a shared template.
    const visible = COLUMNS.filter(
        (c) => caps.canSeeOwnerAsm || (c.key !== "owner_name" && c.key !== "asm_name"),
    );

    const lines = [
        visible.map((c) => csvEscape(c.header)).join(","),
        ...rows.map((r) =>
            visible
                .map((c) => csvEscape(c.date ? fmtDateTime(r[c.key]) : r[c.key]))
                .join(","),
        ),
    ];

    const stamp = fmtDateTime(new Date()).replace(/[: ]/g, "-");
    const truncated = total > rows.length;

    return new Response(
        // BOM so Excel opens it as UTF-8. Without it a dealer name with any
        // non-ASCII character renders as mojibake on a default Windows install,
        // which is where these sheets are actually opened.
        "﻿" + lines.join("\r\n"),
        {
            headers: {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": `attachment; filename="leads-${stamp}.csv"`,
                // Read by the client so a truncated export announces itself
                // instead of looking like the filter simply matched fewer.
                "X-Export-Rows": String(rows.length),
                "X-Export-Total": String(total),
                "X-Export-Truncated": truncated ? "1" : "0",
            },
        },
    );
});
