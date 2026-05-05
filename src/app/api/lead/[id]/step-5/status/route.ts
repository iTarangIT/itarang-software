import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  deployedAssets,
  inventory,
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

    // Scenario derived from kyc_status — drives which Step 5 screen renders.
    const scenario =
      lead.kyc_status === "loan_sanctioned"
        ? "loan_sanctioned"
        : lead.kyc_status === "loan_rejected"
          ? "loan_rejected"
          : lead.kyc_status === "dispatched"
            ? "dispatched"
            : null;

    // For dispatched / sold leads, look up the warranty + dispatch_date so the
    // page can render the "Mark Delivered" panel with an auto-finalize ETA.
    let dispatchInfo: {
      warrantyId: string;
      warrantyEnd: string | null;
      dispatchDate: string | null;
      autoSoldAt: string | null;
    } | null = null;

    if (
      (lead.kyc_status === "dispatched" || lead.kyc_status === "sold") &&
      selection?.battery_serial
    ) {
      const [asset] = await db
        .select({
          id: deployedAssets.id,
          warranty_end_date: deployedAssets.warranty_end_date,
        })
        .from(deployedAssets)
        .where(eq(deployedAssets.serial_number, selection.battery_serial))
        .limit(1);
      const [batteryRow] = await db
        .select({ dispatch_date: inventory.dispatch_date })
        .from(inventory)
        .where(eq(inventory.serial_number, selection.battery_serial))
        .limit(1);
      if (asset) {
        const days = Number(process.env.DISPATCH_TO_SOLD_DAYS ?? "1");
        const dispatchDate = batteryRow?.dispatch_date ?? null;
        const autoSoldAt = dispatchDate
          ? new Date(
              new Date(dispatchDate).getTime() + days * 24 * 60 * 60 * 1000,
            ).toISOString()
          : null;
        dispatchInfo = {
          warrantyId: asset.id,
          warrantyEnd: asset.warranty_end_date
            ? new Date(asset.warranty_end_date).toISOString()
            : null,
          dispatchDate: dispatchDate ? new Date(dispatchDate).toISOString() : null,
          autoSoldAt,
        };
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        leadStatus: lead.kyc_status,
        scenario,
        paymentMethod: lead.payment_method,
        phone: maskedPhone,
        productSelection: selection ?? null,
        loanSanction: loan
          ? {
              ...loan,
              decided_at: loan.sanctioned_at ?? loan.updated_at ?? null,
            }
          : null,
        otp: otp
          ? {
              id: otp.id,
              sendCount: otp.send_count,
              attemptCount: otp.attempt_count,
              maxSends: 3,
              expiresAt: otp.expires_at,
              lockedUntil: otp.locked_until,
              isUsed: otp.is_used,
            }
          : null,
        dispatch: dispatchInfo,
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
