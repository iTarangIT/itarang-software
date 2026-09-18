import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { ADMIN_KYC_SUMMARY_STATUSES, requireAdminAppUser } from "@/lib/kyc/admin-workflow";

// GET /api/admin/kyc-reviews/summary
//
// The summary strip on Admin → KYC Review (/admin/kyc-review).
//
//   queue      — admin_verification_queue rows by status, bucketed exactly as
//                /api/admin/kyc/queue's `summary` (ADMIN_KYC_SUMMARY_STATUSES →
//                pending / inProgress / requestedCorrection / rejected /
//                approved), but counted in SQL instead of loading every row.
//   rejections — distinct leads with at least one rejected document review
//                (admin_kyc_reviews.outcome = 'rejected'), and the latest reason.
//   loans      — loan_sanctions: leads sanctioned (sanctioned / disbursed /
//                closed) and leads disbursed (status disbursed/closed, or
//                disbursed_at set). 'pending' and 'rejected' rows are not
//                sanctions.
//
// Leads the admin deleted (E-285, leads.deleted_by_admin_at) are excluded
// everywhere, matching the queue list this strip sits above.

export const dynamic = "force-dynamic";

export async function GET() {
  const appUser = await requireAdminAppUser();
  if (!appUser) {
    return NextResponse.json(
      { success: false, error: { message: "Unauthorized" } },
      { status: 403 },
    );
  }

  try {
    const rows = (await db.execute(sql`
      WITH live_leads AS (
        SELECT l.id FROM leads l WHERE l.deleted_by_admin_at IS NULL
      )
      SELECT
        (SELECT COALESCE(json_object_agg(x.status, x.n), '{}'::json) FROM (
           SELECT q.status, COUNT(*)::int AS n
             FROM admin_verification_queue q
             JOIN live_leads ll ON ll.id = q.lead_id
            GROUP BY q.status) x)                                              AS queue,
        (SELECT COUNT(DISTINCT r.lead_id)::int
           FROM admin_kyc_reviews r
           JOIN live_leads ll ON ll.id = r.lead_id
          WHERE r.outcome = 'rejected')                                        AS rejected_leads,
        (SELECT row_to_json(x) FROM (
           SELECT r.lead_id, r.rejection_reason, r.document_type, r.reviewed_at
             FROM admin_kyc_reviews r
             JOIN live_leads ll ON ll.id = r.lead_id
            WHERE r.outcome = 'rejected'
            ORDER BY r.reviewed_at DESC
            LIMIT 1) x)                                                        AS latest_rejection,
        (SELECT COUNT(DISTINCT s.lead_id)::int
           FROM loan_sanctions s
           JOIN live_leads ll ON ll.id = s.lead_id
          WHERE s.status IN ('sanctioned', 'disbursed', 'closed'))             AS sanctioned,
        (SELECT COUNT(DISTINCT s.lead_id)::int
           FROM loan_sanctions s
           JOIN live_leads ll ON ll.id = s.lead_id
          WHERE s.status IN ('disbursed', 'closed') OR s.disbursed_at IS NOT NULL) AS disbursed
    `)) as unknown as Array<Record<string, unknown>>;

    const r = rows?.[0] ?? {};
    const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const queue = (r.queue ?? {}) as Record<string, unknown>;
    const byStatus = Object.fromEntries(
      ADMIN_KYC_SUMMARY_STATUSES.map((s) => [s, n(queue[s])]),
    ) as Record<(typeof ADMIN_KYC_SUMMARY_STATUSES)[number], number>;
    const latest = (r.latest_rejection ?? null) as {
      lead_id: string;
      rejection_reason: string | null;
      document_type: string | null;
      reviewed_at: string | null;
    } | null;

    return NextResponse.json({
      success: true,
      data: {
        // Same keys as /api/admin/kyc/queue's `summary`.
        queue: {
          pending: byStatus.pending_itarang_verification,
          inProgress: byStatus.in_progress,
          requestedCorrection: byStatus.requested_correction,
          rejected: byStatus.rejected,
          approved: byStatus.approved,
        },
        rejectedLeads: n(r.rejected_leads),
        latestRejection: latest,
        loans: {
          sanctioned: n(r.sanctioned),
          disbursed: n(r.disbursed),
        },
      },
    });
  } catch (error) {
    console.error("[Admin KYC Review Summary] Error:", error);
    return NextResponse.json(
      { success: false, error: { message: "Failed to load KYC summary" } },
      { status: 500 },
    );
  }
}
