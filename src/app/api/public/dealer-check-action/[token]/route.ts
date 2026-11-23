// 23 Nov (point 4) — the act-on-it link in a dealer-check email / WhatsApp.
//
//   GET  /api/public/dealer-check-action/<token>            → the check (customer, proposed dealer, why)
//   GET  /api/public/dealer-check-action/<token>?q=<name>   → dealer search for "Change dealer"
//   POST /api/public/dealer-check-action/<token> { decision, dealer_id?, reason? }
//
// No login: the signed token (lib/leads/dealer-check-token) names the check and
// the recipient. It only works while the person is still on Settings › Dealer
// check alerts and the check is still pending — the first person to act decides,
// everyone after gets "already decided by <name>". The decision is recorded as
// that person's user id (decided_by) and logged on the KYC timeline.

import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { leadDealerReviews, leads, users } from "@/lib/db/schema";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { DealerCheckError, decideDealerReview, dealerCheckKindLabel } from "@/lib/leads/dealer-assignment";
import { getDealerCheckSettings } from "@/lib/leads/dealer-check-settings";
import { readDealerCheckToken } from "@/lib/leads/dealer-check-token";
import { searchActiveDealers } from "@/lib/leads/dealerByMobile";
import { dealerDisplayNames } from "@/lib/leads/pushGuards";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

async function resolve(token: string) {
  const t = readDealerCheckToken(token);
  if (!t) return { error: errorResponse("This link is not valid.", 404) } as const;
  const { recipients } = await getDealerCheckSettings();
  const recipient = recipients.find((r) => r.userId === t.userId);
  if (!recipient) return { error: errorResponse("This link no longer works — you are not on the dealer check alert list.", 403) } as const;
  const [review] = await db.select().from(leadDealerReviews).where(eq(leadDealerReviews.id, t.reviewId)).limit(1);
  if (!review) return { error: errorResponse("This dealer check no longer exists.", 404) } as const;
  const [person] = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, active: users.is_active })
    .from(users)
    .where(eq(users.id, t.userId))
    .limit(1);
  if (!person || person.active === false) return { error: errorResponse("This link no longer works.", 403) } as const;
  return { review, recipient, person } as const;
}

const needsLoan = (pm: string | null | undefined) => ["finance", "other_finance"].includes((pm ?? "").toLowerCase());

export const GET = withErrorHandler(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  const r = await resolve(token);
  if ("error" in r) return r.error;
  const { review, person } = r;
  const [lead] = await db
    .select({ full_name: leads.full_name, owner_name: leads.owner_name, reference_id: leads.reference_id, city: leads.city, state: leads.state, pm: leads.payment_method })
    .from(leads)
    .where(eq(leads.id, review.lead_id))
    .limit(1);

  const q = new URL(req.url).searchParams.get("q");
  if (q !== null) {
    if (review.status !== "pending") return successResponse({ dealers: [] });
    return successResponse({ dealers: await searchActiveDealers(q, 10, { financeOnly: needsLoan(lead?.pm) }) });
  }

  const names = await dealerDisplayNames([review.dealer_id, review.final_dealer_id ?? ""].filter(Boolean));
  let decidedByName: string | null = null;
  if (review.decided_by) {
    const [u] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, review.decided_by)).limit(1);
    decidedByName = u?.name || u?.email || null;
  }
  const candidates = (Array.isArray(review.candidates) ? review.candidates : []) as Array<{ dealerId: string; name: string }>;
  return successResponse({
    you: person.name || person.email,
    status: review.status,
    customer: lead?.full_name || lead?.owner_name || "Customer",
    reference: lead?.reference_id || review.lead_id,
    place: [lead?.city, lead?.state].filter((x) => x && x !== "Unknown").join(", ") || null,
    payment: lead?.pm ?? null,
    dealer: { id: review.dealer_id, name: names.get(review.dealer_id) ?? review.dealer_id },
    reason: dealerCheckKindLabel(review.reason_kind),
    initiatedBy: review.initiated_by_name,
    otherDealers: candidates.filter((c) => c.dealerId !== review.dealer_id).slice(0, 10),
    decided:
      review.status === "pending"
        ? null
        : {
            by: decidedByName,
            at: review.decided_at,
            note: review.decision_reason,
            finalDealer: review.final_dealer_id ? names.get(review.final_dealer_id) ?? review.final_dealer_id : null,
          },
  });
});

const Body = z.object({
  decision: z.enum(["approve", "change", "reject"]),
  dealer_id: z.string().trim().max(255).optional().nullable(),
  reason: z.string().trim().max(1000).optional().nullable(),
});

export const POST = withErrorHandler(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  const r = await resolve(token);
  if ("error" in r) return r.error;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? "Invalid request", 400);
  try {
    const result = await decideDealerReview({
      reviewId: r.review.id,
      actor: { id: r.person.id, name: r.person.name || r.recipient.name, role: r.person.role ?? null, via: "link" },
      decision: parsed.data.decision,
      newDealerId: parsed.data.dealer_id ?? null,
      reason: parsed.data.reason ?? null,
    });
    return successResponse(result);
  } catch (err) {
    if (err instanceof DealerCheckError) {
      if (err.status === 409) {
        // Somebody else got there first — say who.
        const [fresh] = await db.select({ by: leadDealerReviews.decided_by }).from(leadDealerReviews).where(eq(leadDealerReviews.id, r.review.id)).limit(1);
        let who: string | null = null;
        if (fresh?.by) {
          const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, fresh.by)).limit(1);
          who = u?.name ?? null;
        }
        return errorResponse(who ? `Already decided by ${who}. No action needed.` : err.message, 409);
      }
      return errorResponse(err.message, err.status);
    }
    throw err;
  }
});
