import { NextResponse } from "next/server";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { withErrorHandler, successResponse } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import { calcLeads, calcOtpVerifications } from "@/lib/db/schema";
import { resolveEngineContext } from "@/lib/calculator/config-resolver";
import { calculate, ValidationError, rupeesToPaise } from "@/lib/calculator/engine";
import {
  normalizeCalcPhone,
  sendCalcResultsWhatsApp,
  type CalcResultForSummary,
} from "@/lib/calculator/whatsapp";

export const dynamic = "force-dynamic";

// How long a verified-but-unused OTP stays valid before Calculate. Each OTP is
// SINGLE-USE: the first successful calculation consumes it, and every new
// search needs a fresh OTP sent to and verified by the customer.
const VERIFICATION_WINDOW_MS = 30 * 60 * 1000;

const bodySchema = z.object({
  customerName: z.string().min(1, "Customer name is required"),
  phone: z.string().min(5, "Phone is required"),
  city: z.string().nullable().optional(),
  modelId: z.number().int().positive(),
  tenure: z.number().int().positive(),
  expectedEmi: z.number().nonnegative().optional(),
  upfrontAbility: z.number().nonnegative().optional(),
});

// Card 1 -> Card 2: resolve config, run the verified engine, persist the quote, return cards.
export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireRole(["dealer"]);
  const body = bodySchema.parse(await req.json());

  // OTP gate (E-178): the customer's WhatsApp number must have been verified
  // by this dealer user within the last 30 minutes, and that verification must
  // not already have been spent on a previous calculation (single-use).
  const phone = normalizeCalcPhone(body.phone);
  if (!phone) {
    return NextResponse.json(
      {
        success: false,
        error: { message: "Enter a valid 10-digit Indian mobile number.", code: "invalid_phone" },
        timestamp: new Date().toISOString(),
      },
      { status: 400 },
    );
  }
  const [verification] = await db
    .select()
    .from(calcOtpVerifications)
    .where(
      and(
        eq(calcOtpVerifications.createdBy, user.id),
        eq(calcOtpVerifications.phone, phone),
        gt(calcOtpVerifications.verifiedAt, new Date(Date.now() - VERIFICATION_WINDOW_MS)),
        isNull(calcOtpVerifications.consumedAt),
      ),
    )
    .orderBy(desc(calcOtpVerifications.verifiedAt))
    .limit(1);
  if (!verification) {
    return NextResponse.json(
      {
        success: false,
        error: {
          message: "Customer phone not verified. Send and verify the WhatsApp OTP first.",
          code: "otp_required",
        },
        timestamp: new Date().toISOString(),
      },
      { status: 403 },
    );
  }

  const resolved = await resolveEngineContext({ modelId: body.modelId, city: body.city });

  let result;
  try {
    result = calculate(resolved.ctx, {
      model: resolved.model.displayName,
      tenure: body.tenure,
      expectedEmi: body.expectedEmi,
      upfrontAbility: body.upfrontAbility,
      city: body.city ?? undefined,
    });
  } catch (e) {
    // Map the engine's required-filter/negative validation to a structured 400 (not a 500).
    if (e instanceof ValidationError) {
      return NextResponse.json(
        { success: false, error: { message: e.message, field: e.field }, timestamp: new Date().toISOString() },
        { status: 400 },
      );
    }
    throw e;
  }

  // Persist the saved quote (inputs + result snapshot + config version).
  const [lead] = await db
    .insert(calcLeads)
    .values({
      dealerId: user.dealer_id ?? null,
      customerName: body.customerName,
      phone: body.phone,
      city: body.city ?? null,
      expectedEmiPaise: body.expectedEmi != null ? rupeesToPaise(body.expectedEmi) : null,
      upfrontAbilityPaise: body.upfrontAbility != null ? rupeesToPaise(body.upfrontAbility) : null,
      tenureMonths: body.tenure,
      modelId: body.modelId,
      filterOutcome: result.outcome,
      configVersionId: resolved.configVersionId,
      resultSnapshot: result,
      otpVerificationId: verification.id,
      otpVerifiedAt: verification.verifiedAt,
    })
    .returning({ id: calcLeads.id });

  // Consume the OTP — one verification = one calculation. Done after the lead
  // insert so an engine ValidationError (400 above) doesn't burn the OTP.
  await db
    .update(calcOtpVerifications)
    .set({ consumedAt: new Date() })
    .where(eq(calcOtpVerifications.id, verification.id));

  // Send the scheme summary to the customer's WhatsApp. Awaited (a detached
  // promise may be frozen on serverless before it completes) but best-effort —
  // a delivery failure never fails the calculation.
  const waStatus = await sendCalcResultsWhatsApp(
    phone,
    body.customerName,
    result as unknown as CalcResultForSummary,
    resolved.model.displayName,
  );
  try {
    await db
      .update(calcLeads)
      .set({
        waResultsStatus: waStatus,
        waResultsSentAt: waStatus === "sent" ? new Date() : null,
      })
      .where(eq(calcLeads.id, lead.id));
  } catch (err) {
    console.error("[Calculator] failed to stamp wa_results_status:", err);
  }

  return successResponse({
    ...result,
    model: resolved.model,
    configVersionId: resolved.configVersionId,
    footer: resolved.footer,
    cardDisclaimer: resolved.cardDisclaimer,
    leadId: lead.id,
    waResults: { status: waStatus },
  });
});
