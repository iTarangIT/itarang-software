import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";

import { db } from "@/lib/db";
import { leads, otpConfirmations } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
// ID 183 (16 Oct): dispatch is the file's dealer's — and, since 16 Oct evening, the iTarang house login on a file it pushed out; never Admin / Sales Head acting for the dealer.
import { dealerMayDispatch } from "@/lib/auth/requireLeadAccess";
import { gateLeadActor, recordActorStep, seenFromRequest } from "@/lib/leads/actForDealerGuard";

// BRD V2 §3.3 — Step 5 OTP verification (non-consuming pre-check).
// Confirms the 6-digit OTP the customer read out matches, so the UI can enable
// the "Validate & Confirm Dispatch" action. This does NOT finalize the sale or
// mark the OTP used — dispatch (confirm-dispatch) re-verifies and consumes the
// OTP atomically inside the finalization transaction. Keeping this as a
// separate step lets the dealer confirm the OTP first, then dispatch.

const BodySchema = z.object({
  otp: z.string().regex(/^\d{6}$/, "OTP must be 6 digits"),
});

const MAX_ATTEMPTS = 3;
const LOCK_MS = 5 * 60 * 1000; // 5-minute lockout after MAX_ATTEMPTS wrong attempts

function hashOtp(otp: string): string {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;
    const { otp } = BodySchema.parse(await req.json());

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }
    if (!(await dealerMayDispatch(user, lead.dealer_id, leadId))) {
      return NextResponse.json(
        { success: false, error: { message: "Access denied" } },
        { status: 403 },
      );
    }
    // ID 183 (21 Oct): the file's dealer — stamps his action and clears any
    // iTarang note (dealer wins). The house login on a file it pushed out —
    // takes / refreshes its own 30-minute note (never clears someone else's),
    // is refused when the dealer acted after its page loaded, and the step is
    // recorded "Done by" with a notice to the dealer (below).
    const gate = await gateLeadActor(user, lead, { write: true, dispatch: true, seenDealerActionAt: seenFromRequest(req) });
    if (!gate.ok) {
      return NextResponse.json({ success: false, error: { message: gate.message } }, { status: gate.status });
    }
    if (lead.kyc_status !== "loan_sanctioned") {
      return NextResponse.json(
        { success: false, error: { message: `Lead not awaiting dispatch (kyc_status=${lead.kyc_status})` } },
        { status: 400 },
      );
    }

    const [otpRecord] = await db
      .select()
      .from(otpConfirmations)
      .where(
        and(
          eq(otpConfirmations.lead_id, leadId),
          eq(otpConfirmations.is_used, false),
        ),
      )
      .orderBy(desc(otpConfirmations.created_at))
      .limit(1);

    if (!otpRecord) {
      return NextResponse.json(
        { success: false, error: { message: "No active OTP. Please send a new one." } },
        { status: 400 },
      );
    }

    const now = new Date();
    if (otpRecord.locked_until && now < otpRecord.locked_until) {
      const mins = Math.ceil((otpRecord.locked_until.getTime() - now.getTime()) / 60000);
      return NextResponse.json(
        { success: false, error: { message: `Too many attempts. Locked for ${mins} more minute(s).` } },
        { status: 429 },
      );
    }
    if (now >= otpRecord.expires_at) {
      return NextResponse.json(
        { success: false, error: { message: "OTP expired. Please resend." } },
        { status: 400 },
      );
    }

    if (otpRecord.otp_hash !== hashOtp(otp)) {
      const attempts = otpRecord.attempt_count + 1;
      const update: Partial<typeof otpConfirmations.$inferInsert> = { attempt_count: attempts };
      if (attempts >= MAX_ATTEMPTS) {
        update.locked_until = new Date(now.getTime() + LOCK_MS);
      }
      await db
        .update(otpConfirmations)
        .set(update)
        .where(eq(otpConfirmations.id, otpRecord.id));
      return NextResponse.json(
        {
          success: false,
          error: {
            message: attempts >= MAX_ATTEMPTS
              ? "Incorrect OTP. Too many attempts — locked for 5 minutes."
              : `Incorrect OTP. ${MAX_ATTEMPTS - attempts} attempt(s) remaining.`,
          },
        },
        { status: 400 },
      );
    }

    // Match — clear any accrued wrong-attempt count but leave the OTP unused so
    // confirm-dispatch can consume it. The UI enables the dispatch button now.
    if (otpRecord.attempt_count > 0) {
      await db
        .update(otpConfirmations)
        .set({ attempt_count: 0, locked_until: null })
        .where(eq(otpConfirmations.id, otpRecord.id));
    }

    await recordActorStep(gate.actor, "checked the customer's dispatch code (Step 5)");
    return NextResponse.json({
      success: true,
      data: { verified: true, expiresInSeconds: Math.max(0, Math.floor((otpRecord.expires_at.getTime() - now.getTime()) / 1000)) },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: { message: error.issues[0]?.message ?? "Invalid request" } },
        { status: 400 },
      );
    }
    console.error("[Step 5 Verify OTP] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to verify OTP";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
