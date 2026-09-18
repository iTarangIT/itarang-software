/**
 * E-298 — POST /api/dealer/loans/[sanctionId]/payment-confirmation
 *
 * The dealer tells iTarang whether the lender's disbursal reached their bank.
 * Dealer-only; the sanction's lead must belong to the caller's dealer (checked
 * inside recordDealerPaymentConfirmation, same 404 for "missing" and "not
 * yours"). Once `received`, the answer is final (409).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getAuthenticatedAppUser } from "@/lib/kyc/admin-workflow";
import {
  PaymentConfirmationError,
  recordDealerPaymentConfirmation,
} from "@/lib/leads/dealer-payment-confirmation";

export const dynamic = "force-dynamic";

const Body = z.object({
  received: z.boolean(),
  utr: z.string().trim().max(64).optional().nullable(),
  amount: z.coerce.number().positive().max(1e12).optional().nullable(),
  remarks: z.string().trim().max(1000).optional().nullable(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sanctionId: string }> },
) {
  try {
    const user = await getAuthenticatedAppUser();
    if (!user) {
      return NextResponse.json({ success: false, error: { message: "Unauthorized" } }, { status: 401 });
    }
    if ((user.role ?? "").toLowerCase() !== "dealer" || !user.dealer_id) {
      return NextResponse.json({ success: false, error: { message: "Forbidden" } }, { status: 403 });
    }

    const { sanctionId } = await params;
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { message: parsed.error.issues[0]?.message ?? "Invalid request" } },
        { status: 400 },
      );
    }

    const result = await recordDealerPaymentConfirmation({
      sanctionId,
      dealerId: user.dealer_id,
      received: parsed.data.received,
      utr: parsed.data.utr ?? null,
      amount: parsed.data.amount ?? null,
      remarks: parsed.data.remarks ?? null,
      confirmedBy: user.id,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof PaymentConfirmationError) {
      return NextResponse.json(
        { success: false, error: { message: error.message } },
        { status: error.status },
      );
    }
    console.error("[dealer payment-confirmation] Error:", error);
    return NextResponse.json(
      { success: false, error: { message: "Failed to record payment confirmation" } },
      { status: 500 },
    );
  }
}
