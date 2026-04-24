import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  leads,
  loanSanctions,
  otpConfirmations,
  productSelections,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";

// Consolidated Step 5 state for the dealer page: loan details + product
// summary + active OTP session (if any).

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }
    if (lead.dealer_id !== user.dealer_id) {
      return NextResponse.json(
        { success: false, error: { message: "Access denied" } },
        { status: 403 },
      );
    }

    const [selection] = await db
      .select()
      .from(productSelections)
      .where(eq(productSelections.lead_id, leadId))
      .orderBy(desc(productSelections.created_at))
      .limit(1);

    const [loan] = await db
      .select()
      .from(loanSanctions)
      .where(eq(loanSanctions.lead_id, leadId))
      .orderBy(desc(loanSanctions.created_at))
      .limit(1);

    const [otp] = await db
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

    const maskedPhone = lead.phone
      ? `XXXXXX${String(lead.phone).slice(-4)}`
      : null;

    return NextResponse.json({
      success: true,
      data: {
        leadStatus: lead.kyc_status,
        phone: maskedPhone,
        productSelection: selection ?? null,
        loanSanction: loan ?? null,
        otp: otp
          ? {
              id: otp.id,
              sendCount: otp.send_count,
              attemptCount: otp.attempt_count,
              expiresAt: otp.expires_at,
              lockedUntil: otp.locked_until,
              isUsed: otp.is_used,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("[Step 5 Status] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to load Step 5 state";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
