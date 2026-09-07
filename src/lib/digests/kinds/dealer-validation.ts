/**
 * Dealer Validation digest (E-285), as a descriptor (E-286).
 *
 * The numbers behind Admin → Dealer Validation (/admin/dealer-verification):
 * what the onboarding queue did in a day, and what is still sitting in it.
 *
 * TWO TRAPS THIS FILE EXISTS TO AVOID
 *
 * 1. THE DEAD COLUMN. `dealer_onboarding_applications.correction_requested_at` is
 *    declared in schema.ts and is NEVER WRITTEN — request-correction/route.ts
 *    sets only `onboarding_status`/`review_status`. Confirmed against both live
 *    databases: 0 populated rows while applications sat in correction. Counting
 *    from it would report zero forever, which is the worst kind of wrong because
 *    it looks like a quiet day. The real correction event log is
 *    `dealer_correction_rounds`, one row per request, with `created_at`.
 *
 * 2. THE NAIVE TIMESTAMPS. Every date column on both tables is `timestamp`
 *    WITHOUT time zone holding UTC wall-clock, so every window here uses
 *    `istDayWindowNaive`. See window.ts.
 */

import { sql } from "drizzle-orm";

// `db` is imported INSIDE each query, not at module scope. The registry imports
// every descriptor, and the registry is read by things that must not open a
// database connection to do it — the contract test, and any client-side code
// that wants a kind's label. A top-level `import { db }` makes merely *listing*
// the digests require DATABASE_URL.

import { istDayWindowNaive } from "../window";
import type {
  DigestDetail,
  DigestFigures,
  DigestKindDescriptor,
  DigestSection,
} from "../types";
import { toDetailRows } from "./shared";

const SECTIONS: DigestSection[] = [
  { key: "approved", label: "Approved", hint: "Dealers activated that day.", group: "activity" },
  { key: "rejected", label: "Rejected", hint: "Applications turned down.", group: "activity" },
  {
    key: "correctionRequested",
    label: "Correction requested",
    hint: "Sent back to the dealer for clarification.",
    group: "activity",
  },
  {
    key: "correctionsResolved",
    label: "Corrections resolved",
    hint: "Dealer replied and an admin applied it.",
    group: "activity",
  },
  {
    key: "submissions",
    label: "New submissions",
    hint: "Applications that arrived that day.",
    group: "activity",
  },
  {
    key: "backlog",
    label: "Still outstanding",
    hint: "The four queue totals — the same numbers as the stat cards on the Dealer Validation page.",
    group: "backlog",
  },
];

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * ONE ROUND TRIP, deliberately. The "still outstanding" numbers and the period
 * numbers are read in the same statement so the mail cannot describe a backlog
 * from a moment other than the one it describes the day from.
 *
 * THE BACKLOG BUCKETS MIRROR THE PAGE. The four figures are the four stat cards
 * on /admin/dealer-verification, which are computed in the BROWSER (page.tsx,
 * `stats` useMemo) from a `status` field the API DERIVES
 * (src/app/api/admin/dealer-verifications/route.ts). The `derived` CTE below is
 * that derivation transcribed into SQL, and the three bucket lists are copied
 * from the page verbatim — including the values nothing ever writes
 * (`pending_sales_head`, `agreement_in_progress`, `completed`, `succeed`), so
 * that if a route starts writing one, the mail and the screen change together
 * instead of silently disagreeing.
 */
async function collect(
  istDay: string,
): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const { db } = await import("@/lib/db");
    const rows = (await db.execute(sql`
      WITH derived AS (
        SELECT
          a.id, a.approved_at, a.rejected_at, a.submitted_at, a.onboarding_status,
          CASE
            WHEN a.onboarding_status IN ('approved', 'rejected', 'correction_requested')
              THEN a.onboarding_status
            WHEN a.review_status IS NOT NULL AND a.review_status <> 'draft'
              THEN a.review_status
            ELSE a.onboarding_status
          END AS status
        FROM dealer_onboarding_applications a
        WHERE a.onboarding_status <> 'draft' OR a.submitted_at IS NOT NULL
      )
      SELECT
        (SELECT COUNT(*) FROM derived d
          WHERE d.onboarding_status = 'approved'
            AND ${istDayWindowNaive(sql`d.approved_at`, istDay)})::int    AS approved,
        (SELECT COUNT(*) FROM derived d
          WHERE d.onboarding_status = 'rejected'
            AND ${istDayWindowNaive(sql`d.rejected_at`, istDay)})::int    AS rejected,
        (SELECT COUNT(*) FROM derived d
          WHERE ${istDayWindowNaive(sql`d.submitted_at`, istDay)})::int   AS submitted,
        -- DISTINCT application: two correction rounds on one file in a day is one
        -- dealer being chased, not two.
        (SELECT COUNT(DISTINCT r.application_id) FROM dealer_correction_rounds r
          WHERE ${istDayWindowNaive(sql`r.created_at`, istDay)})::int     AS correction_requested,
        (SELECT COUNT(DISTINCT r.application_id) FROM dealer_correction_rounds r
          WHERE r.status = 'applied' AND r.applied_at IS NOT NULL
            AND ${istDayWindowNaive(sql`r.applied_at`, istDay)})::int     AS correction_resolved,
        (SELECT COUNT(*) FROM derived)::int                               AS open_total,
        (SELECT COUNT(*) FROM derived d WHERE d.status IN
          ('submitted','pending_admin_review','pending_sales_head',
           'under_review','agreement_in_progress'))::int                  AS open_pending_review,
        (SELECT COUNT(*) FROM derived d WHERE d.status IN
          ('under_correction','correction_requested'))::int               AS open_under_correction,
        (SELECT COUNT(*) FROM derived d WHERE d.status IN
          ('approved','completed','succeed'))::int                        AS open_approved
    `)) as unknown as Array<Record<string, unknown>>;

    const r = rows?.[0] ?? {};

    return {
      ok: true,
      figures: {
        activity: [
          { key: "approved", label: "Approved", value: num(r.approved), bucket: "approved" },
          { key: "rejected", label: "Rejected", value: num(r.rejected), bucket: "rejected" },
          {
            key: "correctionRequested",
            label: "Correction requested",
            value: num(r.correction_requested),
            bucket: "correctionRequested",
          },
          {
            key: "correctionsResolved",
            label: "Corrections resolved",
            value: num(r.correction_resolved),
            bucket: "correctionResolved",
          },
          {
            key: "submissions",
            label: "New submissions",
            value: num(r.submitted),
            bucket: "submitted",
          },
        ],
        backlog: [
          { key: "backlog", label: "Waiting for admin action", value: num(r.open_pending_review) },
          { key: "backlog", label: "Need dealer clarification", value: num(r.open_under_correction) },
          { key: "backlog", label: "Dealer accounts activated", value: num(r.open_approved) },
          { key: "backlog", label: "All onboarding submissions", value: num(r.open_total) },
        ],
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[digest:dealer_validation] count query failed:", error);
    return { ok: false, figures: { activity: [], backlog: [] }, error };
  }
}

/**
 * The dealers behind each number, for the "Detailed" format and the Excel
 * attachment. A SEPARATE query from the counts: the summary format is the common
 * case and must not pay for rows nobody will read.
 */
async function collectDetail(
  istDay: string,
): Promise<{ ok: boolean; detail: DigestDetail; error?: string }> {
  // Bounded: a digest is a summary, not an export.
  const CAP = 200;

  try {
    const { db } = await import("@/lib/db");
    const rows = (await db.execute(sql`
      WITH base AS (
        SELECT a.id, a.company_name, a.owner_name, a.city, a.state, a.source,
               a.approved_at, a.rejected_at, a.submitted_at, a.onboarding_status
          FROM dealer_onboarding_applications a
         WHERE a.onboarding_status <> 'draft' OR a.submitted_at IS NOT NULL
      )
      SELECT
        (SELECT COALESCE(json_agg(x ORDER BY x.at DESC), '[]'::json) FROM (
           SELECT b.id, b.company_name AS title, b.owner_name AS subtitle,
                  b.city, b.state, b.source, b.approved_at AS at
             FROM base b WHERE b.onboarding_status = 'approved'
              AND ${istDayWindowNaive(sql`b.approved_at`, istDay)}
            LIMIT ${CAP}) x)                                        AS approved,
        (SELECT COALESCE(json_agg(x ORDER BY x.at DESC), '[]'::json) FROM (
           SELECT b.id, b.company_name AS title, b.owner_name AS subtitle,
                  b.city, b.state, b.source, b.rejected_at AS at
             FROM base b WHERE b.onboarding_status = 'rejected'
              AND ${istDayWindowNaive(sql`b.rejected_at`, istDay)}
            LIMIT ${CAP}) x)                                        AS rejected,
        (SELECT COALESCE(json_agg(x ORDER BY x.at DESC), '[]'::json) FROM (
           SELECT b.id, b.company_name AS title, b.owner_name AS subtitle,
                  b.city, b.state, b.source, b.submitted_at AS at
             FROM base b WHERE ${istDayWindowNaive(sql`b.submitted_at`, istDay)}
            LIMIT ${CAP}) x)                                        AS submitted,
        (SELECT COALESCE(json_agg(x ORDER BY x.at DESC), '[]'::json) FROM (
           SELECT DISTINCT ON (b.id) b.id, b.company_name AS title,
                  b.owner_name AS subtitle, b.city, b.state, b.source,
                  r.created_at AS at
             FROM dealer_correction_rounds r JOIN base b ON b.id = r.application_id
            WHERE ${istDayWindowNaive(sql`r.created_at`, istDay)}
            ORDER BY b.id, r.created_at DESC LIMIT ${CAP}) x)        AS correction_requested,
        (SELECT COALESCE(json_agg(x ORDER BY x.at DESC), '[]'::json) FROM (
           SELECT DISTINCT ON (b.id) b.id, b.company_name AS title,
                  b.owner_name AS subtitle, b.city, b.state, b.source,
                  r.applied_at AS at
             FROM dealer_correction_rounds r JOIN base b ON b.id = r.application_id
            WHERE r.status = 'applied' AND r.applied_at IS NOT NULL
              AND ${istDayWindowNaive(sql`r.applied_at`, istDay)}
            ORDER BY b.id, r.applied_at DESC LIMIT ${CAP}) x)        AS correction_resolved
    `)) as unknown as Array<Record<string, unknown>>;

    const r = rows?.[0] ?? {};

    return {
      ok: true,
      detail: {
        approved: toDetailRows(r.approved),
        rejected: toDetailRows(r.rejected),
        correctionRequested: toDetailRows(r.correction_requested),
        correctionResolved: toDetailRows(r.correction_resolved),
        submitted: toDetailRows(r.submitted),
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[digest:dealer_validation] detail query failed:", error);
    return { ok: false, detail: {}, error };
  }
}

export const dealerValidationDigest: DigestKindDescriptor = {
  id: "dealer_validation",
  label: "Dealer Validation",
  description:
    "A summary of the dealer onboarding queue, emailed twice a day. The morning mail " +
    "reports yesterday; the evening mail reports today so far. Both carry what is still " +
    "waiting, and a button that opens the Dealer Validation queue.",
  settingsKey: "dealer_validation_digest",
  settingsHref: "/admin/settings/dealer-validation",
  ctaHref: "/admin/dealer-verification",
  ctaLabel: "Open Dealer Validation",
  sections: SECTIONS,
  collect,
  collectDetail,
};
