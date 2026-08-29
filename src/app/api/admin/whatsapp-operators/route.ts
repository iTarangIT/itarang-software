// GET  /api/admin/whatsapp-operators — the internal onboarding team + their counts
// POST /api/admin/whatsapp-operators — allowlist a team member's WhatsApp number
//
// E-214. An "operator" is an internal team member who onboards MANY dealers from
// their own single WhatsApp number. Membership is this table and nothing else —
// deliberately not users.role, because the gate keys on an inbound phone and
// users.phone is free-text (see lib/whatsapp/operator-identity.ts).

import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  users,
  whatsappOperators,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import {
  errorResponse,
  successResponse,
  withErrorHandler,
} from "@/lib/api-utils";
import { resolveWhatsAppDealer } from "@/lib/whatsapp/dealer-identity";
import { toWaPhone } from "@/lib/whatsapp/operator-identity";

const READ_ROLES = ["admin", "sales_head", "ceo"];
const WRITE_ROLES = ["admin", "sales_head"];

export const GET = withErrorHandler(async () => {
  await requireRole(READ_ROLES);

  const operators = await db
    .select({
      id: whatsappOperators.id,
      waPhone: whatsappOperators.wa_phone,
      displayName: whatsappOperators.display_name,
      email: whatsappOperators.email,
      userId: whatsappOperators.user_id,
      isActive: whatsappOperators.is_active,
      notes: whatsappOperators.notes,
      createdAt: whatsappOperators.created_at,
      deactivatedAt: whatsappOperators.deactivated_at,
    })
    .from(whatsappOperators)
    .orderBy(desc(whatsappOperators.is_active), desc(whatsappOperators.created_at));

  // Per-operator file counts by onboarding_status, in one grouped pass rather
  // than a query per row.
  const counts = await db
    .select({
      operatorId: dealerOnboardingApplications.onboarding_operator_id,
      status: dealerOnboardingApplications.onboarding_status,
      n: sql<number>`count(*)::int`,
    })
    .from(dealerOnboardingApplications)
    .where(sql`${dealerOnboardingApplications.onboarding_operator_id} is not null`)
    .groupBy(
      dealerOnboardingApplications.onboarding_operator_id,
      dealerOnboardingApplications.onboarding_status,
    );

  const byOperator = new Map<string, Record<string, number>>();
  for (const c of counts) {
    if (!c.operatorId) continue;
    const bucket = byOperator.get(c.operatorId) ?? {};
    bucket[c.status ?? "unknown"] = Number(c.n);
    byOperator.set(c.operatorId, bucket);
  }

  return successResponse({
    operators: operators.map((o) => {
      const c = byOperator.get(o.id) ?? {};
      const total = Object.values(c).reduce((a, b) => a + b, 0);
      return {
        ...o,
        counts: {
          draft: c.draft ?? 0,
          submitted: c.submitted ?? 0,
          approved: c.approved ?? 0,
          rejected: c.rejected ?? 0,
          total,
        },
      };
    }),
  });
});

export const POST = withErrorHandler(async (req: Request) => {
  const actor = await requireRole(WRITE_ROLES);
  const body = await req.json().catch(() => ({}));

  const displayName = String(body?.displayName ?? "").trim();
  const rawPhone = String(body?.waPhone ?? "").trim();
  const email = String(body?.email ?? "").trim() || null;
  const notes = String(body?.notes ?? "").trim() || null;
  const allowDealerNumber = body?.allowDealerNumber === true;

  if (!displayName) return errorResponse("Name is required", 400);

  const waPhone = toWaPhone(rawPhone);
  if (!waPhone) return errorResponse("Enter a valid WhatsApp number", 400);

  const [dupe] = await db
    .select({ id: whatsappOperators.id, isActive: whatsappOperators.is_active })
    .from(whatsappOperators)
    .where(eq(whatsappOperators.wa_phone, waPhone))
    .limit(1);
  if (dupe) {
    return errorResponse(
      dupe.isActive
        ? "That number is already an onboarding operator."
        : "That number was an operator before — re-activate it instead of adding it again.",
      409,
    );
  }

  // A number that is already an active DEALER would lose its dealer console to
  // the operator gate (which returns before the console gates in runTurn). The
  // operator menu does expose a "My Dealer Console" row for exactly this case,
  // so it is allowed — but only deliberately.
  const asDealer = await resolveWhatsAppDealer(waPhone).catch(() => null);
  if (asDealer && !allowDealerNumber) {
    return errorResponse(
      `That number already belongs to dealer ${asDealer.dealerName ?? asDealer.dealerCode}. ` +
        "Confirm to add it anyway — they'll reach their dealer console from the operator menu.",
      409,
    );
  }

  // Optional link to a CRM login, matched on id (never on email — Supabase Auth
  // lowercases emails while users.email is mixed-case).
  let userId: string | null = null;
  if (body?.userId) {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, String(body.userId)), eq(users.is_active, true)))
      .limit(1);
    userId = u?.id ?? null;
  }

  const [created] = await db
    .insert(whatsappOperators)
    .values({
      wa_phone: waPhone,
      display_name: displayName,
      email,
      user_id: userId,
      notes,
      created_by: actor.id,
      is_active: true,
    })
    .returning();

  return successResponse({ operator: created }, 201);
});
