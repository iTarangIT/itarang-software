/**
 * KYC Review digest (E-288).
 *
 * The numbers behind Admin → KYC Review (/admin/kyc-review): what the KYC queue
 * decided in a day, and what is still sitting in it.
 *
 * FOUR THINGS THIS FILE EXISTS TO GET RIGHT
 *
 * 1. COUNT EVENTS, NOT THE CASE ROW. `admin_verification_queue` carries ONE
 *    decision timestamp, `reviewed_at`, overwritten on each decision. A case sent
 *    back for correction at 10:00 and approved at 16:00 the same day counts ONCE,
 *    as approved — the correction is gone. So every activity figure here comes
 *    from `audit_logs`, which is append-only: one row per event, with
 *    `entity_type='kyc_final_decision'`, `action` ∈ approved | rejected |
 *    dealer_action_required, and `changes->>'decided_by'` ∈ admin | system.
 *    Verified on live data: 91 approvals + 2 rejections, with a clean
 *    human/automatic split per day.
 *
 * 2. ACTIVITY COUNTS EVERYTHING; BACKLOG JOINS LIVE LEADS. Roughly 90% of queue
 *    rows point at leads that were later hard-deleted (155 rows, 43 surviving
 *    leads). The work still happened — 31 Aug really was 11 approvals — so the
 *    day's figures count every event. But "still outstanding" is a to-do list,
 *    and a line you cannot open is not a to-do, so the backlog INNER JOINs
 *    `leads`, exactly as /api/admin/kyc/queue and the KYC Review page both do.
 *    That is why the backlog can read 0 while the raw table holds 65.
 *
 * 3. TIMESTAMPTZ, SO NO UTC LIFT. Unlike the dealer-onboarding tables, every
 *    column here is `timestamp with time zone`. `istDayWindowTz` — not the naive
 *    variant. Using the wrong one is a silent 5h30m shift.
 *
 * 4. NEVER BUILD ON THE DEAD VALUES. `admin_verification_queue.status` values
 *    `requested_more_info` and `cancelled` are never written by any code;
 *    `assigned_to` is never a real assignment; and the dotted notification types
 *    `kyc.verified` / `kyc.rejected` / `kyc.docs_requested` / `kyc.final_decision`
 *    are catalogued but never emitted, so a `type LIKE 'kyc.%'` digest would miss
 *    every terminal decision. None of them appear below.
 */

import { sql } from "drizzle-orm";

// `db` is imported INSIDE each query, not at module scope. The registry imports
// every descriptor, and the registry is read by things that must not open a
// database connection to do it — the contract test, and any client-side code
// that wants a kind's label. A top-level `import { db }` makes merely *listing*
// the digests require DATABASE_URL.

import { istDayWindowTz } from "../window";
import type {
  DigestDetail,
  DigestFigures,
  DigestKindDescriptor,
  DigestSection,
} from "../types";
import { toDetailRows } from "./shared";

const SECTIONS: DigestSection[] = [
  {
    key: "approved",
    label: "Approved",
    hint: "Cases cleared, split into decisions a person made and ones the SLA sweep made.",
    group: "activity",
  },
  { key: "rejected", label: "Rejected", hint: "Cases turned down.", group: "activity" },
  {
    key: "correction",
    label: "Sent back for correction",
    hint: "Returned to the dealer for more work.",
    group: "activity",
  },
  {
    key: "submissions",
    label: "New cases submitted",
    hint: "Cases that arrived in the queue that day.",
    group: "activity",
  },
  {
    key: "docRequests",
    label: "Documents requested",
    hint: "Supporting documents asked for from the dealer.",
    group: "activity",
  },
  {
    key: "docReviews",
    label: "Documents reviewed",
    hint: "Individual documents verified, rejected, or sent back for more.",
    group: "activity",
  },
  {
    key: "cards",
    label: "Verification cards actioned",
    hint: "Aadhaar, PAN, bank, CIBIL and RC cards accepted or rejected. One case produces up to five.",
    group: "activity",
  },
  {
    key: "backlog",
    label: "Still outstanding",
    hint: "What is waiting right now. Counts only cases whose lead still exists, so every line can be opened.",
    group: "backlog",
  },
  {
    key: "ageing",
    label: "SLA and ageing",
    hint: "Cases due to auto-approve before the next digest, and how long the oldest one has waited.",
    group: "backlog",
  },
];

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * ONE ROUND TRIP so the backlog and the day's figures describe the same moment.
 *
 * `audit_logs.created_at` is the event clock. (The table also has a `timestamp`
 * column; both are timestamptz and both default to now(), but `created_at` is the
 * one every writer sets explicitly.)
 */
async function collect(
  istDay: string,
): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const { db } = await import("@/lib/db");
    const rows = (await db.execute(sql`
      SELECT
        -- ---- the day, from the append-only event log -------------------------
        (SELECT COUNT(*) FROM audit_logs a
          WHERE a.entity_type = 'kyc_final_decision' AND a.action = 'approved'
            AND ${istDayWindowTz(sql`a.created_at`, istDay)})::int          AS approved,
        (SELECT COUNT(*) FROM audit_logs a
          WHERE a.entity_type = 'kyc_final_decision' AND a.action = 'approved'
            AND COALESCE(a.changes->>'decided_by', 'admin') = 'system'
            AND ${istDayWindowTz(sql`a.created_at`, istDay)})::int          AS approved_auto,
        (SELECT COUNT(*) FROM audit_logs a
          WHERE a.entity_type = 'kyc_final_decision' AND a.action = 'rejected'
            AND ${istDayWindowTz(sql`a.created_at`, istDay)})::int          AS rejected,
        (SELECT COUNT(*) FROM audit_logs a
          WHERE a.entity_type = 'kyc_final_decision'
            AND a.action = 'dealer_action_required'
            AND ${istDayWindowTz(sql`a.created_at`, istDay)})::int          AS correction,

        -- DISTINCT lead: ensureAdminKycQueueEntry can create a row at consent
        -- time and the co-borrower path re-stamps submitted_at, so counting rows
        -- would double-count one case. created_at is set explicitly on insert.
        (SELECT COUNT(DISTINCT q.lead_id) FROM admin_verification_queue q
          WHERE ${istDayWindowTz(sql`q.created_at`, istDay)})::int          AS submissions,

        (SELECT COUNT(*) FROM other_document_requests o
          WHERE ${istDayWindowTz(sql`o.created_at`, istDay)})::int          AS doc_requests,

        -- admin_kyc_reviews is append-only, one row per document review action.
        (SELECT COUNT(*) FROM admin_kyc_reviews r
          WHERE r.outcome = 'verified'
            AND ${istDayWindowTz(sql`r.reviewed_at`, istDay)})::int         AS docs_verified,
        (SELECT COUNT(*) FROM admin_kyc_reviews r
          WHERE r.outcome = 'rejected'
            AND ${istDayWindowTz(sql`r.reviewed_at`, istDay)})::int         AS docs_rejected,
        (SELECT COUNT(*) FROM admin_kyc_reviews r
          WHERE r.outcome = 'request_additional'
            AND ${istDayWindowTz(sql`r.reviewed_at`, istDay)})::int         AS docs_more,

        (SELECT COUNT(*) FROM audit_logs a
          WHERE a.entity_type = 'kyc_verification'
            AND a.action IN ('card_accept', 'card_manual_accept')
            AND ${istDayWindowTz(sql`a.created_at`, istDay)})::int          AS cards_accepted,
        (SELECT COUNT(*) FROM audit_logs a
          WHERE a.entity_type = 'kyc_verification'
            AND a.action IN ('card_reject', 'card_manual_reject')
            AND ${istDayWindowTz(sql`a.created_at`, istDay)})::int          AS cards_rejected,

        -- ---- right now, live leads only (see header note 2) -----------------
        (SELECT COUNT(*) FROM admin_verification_queue q
           JOIN leads l ON l.id = q.lead_id AND l.deleted_by_admin_at IS NULL
          WHERE q.status = 'pending_itarang_verification')::int             AS open_pending,
        (SELECT COUNT(*) FROM admin_verification_queue q
           JOIN leads l ON l.id = q.lead_id AND l.deleted_by_admin_at IS NULL
          WHERE q.status = 'requested_correction')::int                     AS open_correction,
        (SELECT COUNT(*) FROM other_document_requests o
           JOIN leads l ON l.id = o.lead_id AND l.deleted_by_admin_at IS NULL
          WHERE o.upload_status IN ('pending', 'not_uploaded'))::int        AS open_doc_requests,

        -- Cases the SLA sweep will clear within the next 12h. NULL on every row
        -- unless KYC auto-approval is switched on, hence the IS NOT NULL guard.
        (SELECT COUNT(*) FROM admin_verification_queue q
           JOIN leads l ON l.id = q.lead_id AND l.deleted_by_admin_at IS NULL
          WHERE q.auto_approved_at IS NULL
            AND q.sla_next_due_at IS NOT NULL
            AND q.sla_next_due_at <= now() + interval '12 hours')::int      AS due_to_auto,

        (SELECT EXTRACT(DAY FROM now() - MIN(q.created_at))::int
           FROM admin_verification_queue q
           JOIN leads l ON l.id = q.lead_id AND l.deleted_by_admin_at IS NULL
          WHERE q.status = 'pending_itarang_verification')                  AS oldest_days
    `)) as unknown as Array<Record<string, unknown>>;

    const r = rows?.[0] ?? {};
    const approved = num(r.approved);
    const approvedAuto = num(r.approved_auto);
    const oldest = r.oldest_days == null ? null : num(r.oldest_days);

    return {
      ok: true,
      figures: {
        activity: [
          { key: "approved", label: "Approved", value: approved, bucket: "approved" },
          {
            key: "approved",
            label: "by a person",
            value: approved - approvedAuto,
            indent: true,
          },
          { key: "approved", label: "automatic (SLA)", value: approvedAuto, indent: true },
          { key: "rejected", label: "Rejected", value: num(r.rejected), bucket: "rejected" },
          {
            key: "correction",
            label: "Sent back for correction",
            value: num(r.correction),
            bucket: "correction",
          },
          {
            key: "submissions",
            label: "New cases submitted",
            value: num(r.submissions),
            bucket: "submissions",
          },
          { key: "docRequests", label: "Documents requested", value: num(r.doc_requests) },
          { key: "docReviews", label: "Documents verified", value: num(r.docs_verified) },
          { key: "docReviews", label: "Documents rejected", value: num(r.docs_rejected), indent: true },
          { key: "docReviews", label: "More documents asked for", value: num(r.docs_more), indent: true },
          { key: "cards", label: "Cards accepted", value: num(r.cards_accepted) },
          { key: "cards", label: "Cards rejected", value: num(r.cards_rejected), indent: true },
        ],
        backlog: [
          { key: "backlog", label: "Waiting for review", value: num(r.open_pending) },
          { key: "backlog", label: "Awaiting correction", value: num(r.open_correction) },
          { key: "backlog", label: "Open document requests", value: num(r.open_doc_requests) },
          { key: "ageing", label: "Due to auto-approve within 12h", value: num(r.due_to_auto) },
          {
            key: "ageing",
            label: "Oldest case waiting",
            value: oldest ?? 0,
            display: oldest == null ? "nothing waiting" : `${oldest} day${oldest === 1 ? "" : "s"}`,
          },
        ],
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[digest:kyc_review] count query failed:", error);
    return { ok: false, figures: { activity: [], backlog: [] }, error };
  }
}

/**
 * The cases behind each figure.
 *
 * LEFT JOIN `leads`, not inner: the activity figures count every event, so the
 * lists that expand under them must too. Where the lead is gone the row says so
 * rather than disappearing — a list that silently contains fewer rows than the
 * number above it is worse than one that admits what it lost.
 */
async function collectDetail(
  istDay: string,
): Promise<{ ok: boolean; detail: DigestDetail; error?: string }> {
  const CAP = 200;

  // audit_logs.entity_id is the lead id for kyc_final_decision rows.
  const decisionList = (action: string) => sql`
    (SELECT COALESCE(json_agg(x ORDER BY x.at DESC), '[]'::json) FROM (
       SELECT a.entity_id AS id,
              COALESCE(l.owner_name, '(lead deleted)') AS title,
              acc.business_entity_name AS subtitle,
              l.city, l.state,
              COALESCE(a.changes->>'decided_by', 'admin') AS source,
              a.created_at AS at
         FROM audit_logs a
         LEFT JOIN leads l ON l.id = a.entity_id
         LEFT JOIN accounts acc ON acc.id = l.dealer_id
        WHERE a.entity_type = 'kyc_final_decision' AND a.action = ${action}
          AND ${istDayWindowTz(sql`a.created_at`, istDay)}
        LIMIT ${CAP}) x)`;

  try {
    const { db } = await import("@/lib/db");
    const rows = (await db.execute(sql`
      SELECT
        ${decisionList("approved")}                AS approved,
        ${decisionList("rejected")}                AS rejected,
        ${decisionList("dealer_action_required")}  AS correction,
        (SELECT COALESCE(json_agg(x ORDER BY x.at DESC), '[]'::json) FROM (
           SELECT DISTINCT ON (q.lead_id) q.lead_id AS id,
                  COALESCE(l.owner_name, '(lead deleted)') AS title,
                  acc.business_entity_name AS subtitle,
                  l.city, l.state, q.priority AS source, q.created_at AS at
             FROM admin_verification_queue q
             LEFT JOIN leads l ON l.id = q.lead_id
             LEFT JOIN accounts acc ON acc.id = l.dealer_id
            WHERE ${istDayWindowTz(sql`q.created_at`, istDay)}
            ORDER BY q.lead_id, q.created_at DESC
            LIMIT ${CAP}) x)                       AS submissions
    `)) as unknown as Array<Record<string, unknown>>;

    const r = rows?.[0] ?? {};

    return {
      ok: true,
      detail: {
        approved: toDetailRows(r.approved),
        rejected: toDetailRows(r.rejected),
        correction: toDetailRows(r.correction),
        submissions: toDetailRows(r.submissions),
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[digest:kyc_review] detail query failed:", error);
    return { ok: false, detail: {}, error };
  }
}

export const kycReviewDigest: DigestKindDescriptor = {
  id: "kyc_review",
  label: "KYC Review",
  description:
    "A summary of the customer KYC queue, emailed twice a day. The morning mail reports " +
    "yesterday; the evening mail reports today so far. Both carry what is still waiting, " +
    "and a button that opens the KYC Review queue.",
  settingsKey: "kyc_review_digest",
  settingsHref: "/admin/settings/kyc-review",
  ctaHref: "/admin/kyc-review",
  ctaLabel: "Open KYC Review",
  sections: SECTIONS,
  collect,
  collectDetail,
};
