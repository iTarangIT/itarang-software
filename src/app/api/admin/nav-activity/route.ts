// GET /api/admin/nav-activity
//
// "How many NEW items have landed in each admin queue since I last looked?" —
// drives the notification badges on the Dealer Validation, KYC Review and
// WhatsApp Onboarding sidebar links.
//
// The caller supplies its own last-seen timestamp per queue (kept in
// localStorage, so the badge follows the person rather than the account) and
// gets back a count of arrivals strictly after it. A missing timestamp means
// "no baseline yet" and deliberately returns 0 rather than the whole backlog —
// otherwise a first-ever page load would light up with 13/34/50 items that
// nobody would call new.
//
// Counts are of ARRIVALS, not of outstanding work: the badge answers "has
// something come in?", and clears once you open the page. The queues themselves
// remain the place to see the full pending workload.

import { and, eq, gt, ne, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db/index";
import {
  adminVerificationQueue,
  dealerOnboardingApplications,
  whatsappOnboardingSessions,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";

// The roles whose sidebar actually carries at least one of these three links.
const READ_ROLES = ["admin", "sales_head", "ceo", "business_head"];

const QuerySchema = z.object({
  dealerValidation: z.coerce.date().optional(),
  kycReview: z.coerce.date().optional(),
  whatsappOnboarding: z.coerce.date().optional(),
});

async function countOf(
  since: Date | undefined,
  run: (since: Date) => Promise<number>,
): Promise<number> {
  if (!since || Number.isNaN(since.getTime())) return 0;
  return run(since);
}

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole(READ_ROLES);

  const url = new URL(req.url);
  const since = QuerySchema.parse(Object.fromEntries(url.searchParams));

  const [dealerValidation, kycReview, whatsappOnboarding] = await Promise.all([
    // Newly submitted dealer applications still awaiting a verdict. Keyed on
    // submitted_at, not created_at: a WhatsApp draft row is created on the very
    // first "Hi" and would otherwise count as a submission days early.
    countOf(since.dealerValidation, async (s) => {
      const [row] = await db
        .select({ count: sql<number>`cast(count(*) as integer)` })
        .from(dealerOnboardingApplications)
        .where(
          and(
            gt(dealerOnboardingApplications.submitted_at, s),
            eq(dealerOnboardingApplications.onboarding_status, "submitted"),
            notInArray(dealerOnboardingApplications.review_status, [
              "approved",
              "rejected",
            ]),
          ),
        );
      return row?.count ?? 0;
    }),

    // New leads pushed into the KYC queue and not yet reviewed.
    countOf(since.kycReview, async (s) => {
      const [row] = await db
        .select({ count: sql<number>`cast(count(*) as integer)` })
        .from(adminVerificationQueue)
        .where(
          and(
            gt(adminVerificationQueue.created_at, s),
            eq(adminVerificationQueue.status, "pending_itarang_verification"),
          ),
        );
      return row?.count ?? 0;
    }),

    // New CONTACTS on WhatsApp — one session row is created the first time a
    // number ever messages us, so counting rows counts first-time senders. An
    // ongoing back-and-forth with someone already in the list doesn't re-alert.
    // operator_hub is the internal team's own menu row, never a prospect.
    countOf(since.whatsappOnboarding, async (s) => {
      const [row] = await db
        .select({ count: sql<number>`cast(count(*) as integer)` })
        .from(whatsappOnboardingSessions)
        .where(
          and(
            gt(whatsappOnboardingSessions.created_at, s),
            ne(whatsappOnboardingSessions.session_kind, "operator_hub"),
          ),
        );
      return row?.count ?? 0;
    }),
  ]);

  return successResponse({
    dealerValidation,
    kycReview,
    whatsappOnboarding,
  });
});
