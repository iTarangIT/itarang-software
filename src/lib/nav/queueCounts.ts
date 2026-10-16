// ID 90 — the waiting count of each work queue the left menu carries, for
// /api/admin/nav-counts. Every count is the queue page's own rule: where the
// page has a helper (or now shares a predicate with this file) it is called
// here; the three below restate a page's rule in SQL and say where it lives.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { approvals, dualApprovalRequests, expenseSubmissions } from "@/lib/db/schema";
import { countOnboardingDropouts, fetchEscalationQueue, fetchMergeRequests } from "@/lib/admin/listQueries";
import { pendingApprovalsWhere, type ApprovalQueueRole } from "@/lib/approvals/queue";
import { countDealerValidationPending } from "@/lib/dealer/validationQueue";
import { countNumberRepair } from "@/lib/leads/contactability";
import { summarizeNeedsAttention } from "@/lib/leads/needsAttention";
import { countAwaitingAssignment } from "@/lib/leads/salesReady";
import { pendingFinancingDeviationWhere } from "@/lib/nbfc/dual-approval/financingQueue";
import { whatsappOnboardingSummary } from "@/lib/whatsapp/onboardingSummary";
import type { NavCountKey } from "@/lib/nav/navCountKeys";

const countRows = (rows: unknown): number => Number((rows as Array<{ n: unknown }>)[0]?.n ?? 0);

/** /sales-head/approvals (level 1) or /business-head/approvals (level 2). */
async function countApprovals(role: ApprovalQueueRole): Promise<number> {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(approvals).where(pendingApprovalsWhere(role));
    return Number(row?.n ?? 0);
}

/**
 * KYC review: the page's "Pending verification" figure — verification-queue
 * rows still pending_itarang_verification on leads the admin has not deleted
 * (/api/admin/kyc-reviews/summary, `queue.pending`).
 */
async function countKycPending(): Promise<number> {
    return countRows(
        await db.execute(sql`
            SELECT COUNT(*)::int AS n
              FROM admin_verification_queue q
              JOIN leads l ON l.id = q.lead_id AND l.deleted_by_admin_at IS NULL
             WHERE q.status = 'pending_itarang_verification'
        `),
    );
}

/**
 * Product review: the page's `kpis.pending` (/api/admin/product-reviews) — the
 * latest product selection of each lead among the newest 1000, lead not
 * deleted by the admin, and neither the selection's admin_decision nor the
 * lead's latest loan sanction is 'sanctioned' or 'rejected'.
 */
async function countProductReviewPending(): Promise<number> {
    return countRows(
        await db.execute(sql`
            WITH recent AS (
                SELECT ps.lead_id, ps.admin_decision, ps.created_at
                  FROM product_selections ps
                 ORDER BY ps.created_at DESC
                 LIMIT 1000
            ), latest AS (
                SELECT DISTINCT ON (r.lead_id) r.lead_id, r.admin_decision
                  FROM recent r
                 ORDER BY r.lead_id, r.created_at DESC
            ), sanction AS (
                SELECT DISTINCT ON (s.lead_id) s.lead_id, s.status
                  FROM loan_sanctions s
                 WHERE s.lead_id IN (SELECT lead_id FROM latest)
                 ORDER BY s.lead_id, s.created_at DESC
            )
            SELECT COUNT(*)::int AS n
              FROM latest x
              JOIN leads l ON l.id = x.lead_id AND l.deleted_by_admin_at IS NULL
              LEFT JOIN sanction s ON s.lead_id = x.lead_id
             WHERE LOWER(COALESCE(x.admin_decision, '')) NOT IN ('sanctioned', 'rejected')
               AND LOWER(COALESCE(s.status, '')) NOT IN ('sanctioned', 'rejected')
        `),
    );
}

/** /ceo/expenses, Pending tab (/api/admin/expenses?status=pending). */
async function countExpensesPending(): Promise<number> {
    const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(expenseSubmissions)
        .where(sql`${expenseSubmissions.status} = 'pending'`);
    return Number(row?.n ?? 0);
}

async function countFinancingPending(): Promise<number> {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(dualApprovalRequests).where(pendingFinancingDeviationWhere);
    return Number(row?.n ?? 0);
}

const FIRST_PAGE = { page: 1, limit: 1, q: null };

/** How each queue is counted. `role` only matters for Approvals. */
const COUNTERS: Record<NavCountKey, (role: string) => Promise<number>> = {
    approvals: (role) => countApprovals(role === "business_head" ? "business_head" : "sales_head"),
    escalations: async () => (await fetchEscalationQueue("pending", FIRST_PAGE)).total,
    readyToAssign: async () => (await countAwaitingAssignment()).total,
    productReview: countProductReviewPending,
    kycReview: countKycPending,
    dealerValidation: countDealerValidationPending,
    whatsappOnboarding: async () => (await whatsappOnboardingSummary()).inProgress,
    // The page's headline: idle leads over every holder (non-responsive apart).
    needsAttention: async () => (await summarizeNeedsAttention()).reduce((s, h) => s + h.idle, 0),
    mergeRequests: async () => (await fetchMergeRequests("pending", FIRST_PAGE)).total,
    numberRepair: countNumberRepair,
    onboardingDropouts: countOnboardingDropouts,
    expenseApprovals: countExpensesPending,
    financingApprovals: countFinancingPending,
};

const ADMIN_QUEUES: NavCountKey[] = [
    "escalations",
    "readyToAssign",
    "productReview",
    "kycReview",
    "dealerValidation",
    "whatsappOnboarding",
    "needsAttention",
    "mergeRequests",
    "numberRepair",
    "onboardingDropouts",
];

/**
 * The queues each role's menu shows a count on (SidebarRedesign.tsx `counts`
 * for CEO / Admin / Sales Head). The CEO's Quote and NBFC approvals have their
 * own badge fetches in sidebar.tsx. Business Head keeps the old menu: its
 * Approvals (level 2) and the review queues it had badges on.
 */
export const NAV_QUEUES_BY_ROLE: Record<string, NavCountKey[]> = {
    ceo: ["escalations", "expenseApprovals", "financingApprovals"],
    admin: ADMIN_QUEUES,
    sales_head: ["approvals", ...ADMIN_QUEUES],
    business_head: ["approvals", "kycReview", "productReview"],
};

/** Every queue of this role, counted in parallel; a queue that fails is left out. */
export async function navQueueCounts(role: string): Promise<Partial<Record<NavCountKey, number>>> {
    const keys = NAV_QUEUES_BY_ROLE[role] ?? [];
    const settled = await Promise.allSettled(keys.map((k) => COUNTERS[k](role)));
    const out: Partial<Record<NavCountKey, number>> = {};
    settled.forEach((r, i) => {
        if (r.status === "fulfilled") out[keys[i]!] = r.value;
        else console.warn(`[nav-counts] ${keys[i]} failed:`, r.reason instanceof Error ? r.reason.message : r.reason);
    });
    return out;
}
