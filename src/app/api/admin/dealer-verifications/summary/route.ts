import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { istRangeNaive, parseIsoDay } from "@/lib/digests/window";

// GET /api/admin/dealer-verifications/summary?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
//
// Server-side stat cards for Admin → Dealer Verification. The queue page used
// to count its cards in the browser from whatever the list route returned,
// which could not honour the date range and could not see correction rounds.
//
// Each figure is an EVENT in the range, bounded on that event's own column:
//   submitted            submitted_at
//   approved             approved_at   (onboarding_status = 'approved')
//   rejected             rejected_at   (onboarding_status = 'rejected')
//   correctionRequested  dealer_correction_rounds.created_at, DISTINCT application.
//                        NOT dealer_onboarding_applications.correction_requested_at,
//                        which is declared but never written (see
//                        src/lib/digests/kinds/dealer-validation.ts).
//   pendingReview        applications submitted in the range whose derived status
//                        is still waiting for admin action right now — the same
//                        bucket list as the page's old card and the digest.
//
// Timestamps on both tables are naive UTC wall-clock; the range is IST days,
// via istRangeNaive (the same lift as the Dealer Validation digest). No range →
// all time.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;

  const from = parseIsoDay(req.nextUrl.searchParams.get("dateFrom"));
  const to = parseIsoDay(req.nextUrl.searchParams.get("dateTo"));

  try {
    const rows = (await db.execute(sql`
      WITH derived AS (
        SELECT
          a.id, a.submitted_at, a.approved_at, a.rejected_at, a.onboarding_status,
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
          WHERE d.submitted_at IS NOT NULL
            AND ${istRangeNaive(sql`d.submitted_at`, from, to)})::int          AS submitted,
        (SELECT COUNT(*) FROM derived d
          WHERE d.onboarding_status = 'approved' AND d.approved_at IS NOT NULL
            AND ${istRangeNaive(sql`d.approved_at`, from, to)})::int           AS approved,
        (SELECT COUNT(*) FROM derived d
          WHERE d.onboarding_status = 'rejected' AND d.rejected_at IS NOT NULL
            AND ${istRangeNaive(sql`d.rejected_at`, from, to)})::int           AS rejected,
        (SELECT COUNT(DISTINCT r.application_id) FROM dealer_correction_rounds r
          WHERE ${istRangeNaive(sql`r.created_at`, from, to)})::int            AS correction_requested,
        (SELECT COUNT(*) FROM dealer_correction_rounds r
          WHERE ${istRangeNaive(sql`r.created_at`, from, to)})::int            AS correction_rounds,
        (SELECT COUNT(*) FROM derived d
          WHERE d.status IN ('submitted', 'pending_admin_review', 'pending_sales_head',
                             'under_review', 'agreement_in_progress')
            AND (${from}::text IS NULL AND ${to}::text IS NULL
                 OR (d.submitted_at IS NOT NULL
                     AND ${istRangeNaive(sql`d.submitted_at`, from, to)})))::int AS pending_review,
        (SELECT COUNT(*) FROM derived)::int                                    AS total
    `)) as unknown as Array<Record<string, unknown>>;

    const r = rows?.[0] ?? {};
    const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

    return NextResponse.json({
      success: true,
      range: { dateFrom: from, dateTo: to },
      counts: {
        submitted: n(r.submitted),
        approved: n(r.approved),
        rejected: n(r.rejected),
        correctionRequested: n(r.correction_requested),
        correctionRounds: n(r.correction_rounds),
        pendingReview: n(r.pending_review),
        total: n(r.total),
      },
    });
  } catch (error) {
    console.error("ADMIN DEALER VERIFICATIONS SUMMARY ERROR:", error);
    return NextResponse.json(
      { success: false, message: "Failed to load dealer verification counts" },
      { status: 500 },
    );
  }
}
