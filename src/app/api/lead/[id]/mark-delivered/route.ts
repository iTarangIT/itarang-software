import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { deployedAssets, leads, productSelections } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { markDispatchedAsSold } from "@/lib/sales/sale-finalization";
import { notifyDelivered } from "@/lib/notifications";
import { sendKycSms } from "@/lib/sms";

// BRD V2 §3.5 — manual "Mark Delivered" endpoint.
// Flips a lead that's currently in 'dispatched' state through to 'sold'.
// Idempotent: a second call on an already-sold lead returns success with
// alreadySold=true and does not duplicate notifications or SMS.

export async function POST(
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

    if (lead.kyc_status === "sold") {
      return NextResponse.json({
        success: true,
        data: { leadStatus: "sold", alreadySold: true },
      });
    }
    if (lead.kyc_status !== "dispatched") {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `Lead is not in dispatched state (kyc_status=${lead.kyc_status}). Cannot mark delivered.`,
          },
        },
        { status: 400 },
      );
    }

    const [selection] = await db
      .select()
      .from(productSelections)
      .where(eq(productSelections.lead_id, leadId))
      .orderBy(desc(productSelections.created_at))
      .limit(1);
    if (!selection || !selection.battery_serial) {
      return NextResponse.json(
        { success: false, error: { message: "No product selection on this lead" } },
        { status: 400 },
      );
    }

    const now = new Date();
    const result = await db.transaction(async (tx) => {
      const flip = await markDispatchedAsSold({
        tx,
        leadId,
        batterySerial: selection.battery_serial!,
        chargerSerial: selection.charger_serial ?? null,
        performedBy: user.id,
        soldAt: now,
      });

      await tx
        .update(leads)
        .set({ kyc_status: "sold", sold_at: now, updated_at: now })
        .where(eq(leads.id, leadId));

      return flip;
    });

    // Find warranty for the response + customer SMS
    const [asset] = await db
      .select({
        id: deployedAssets.id,
        warranty_end_date: deployedAssets.warranty_end_date,
      })
      .from(deployedAssets)
      .where(eq(deployedAssets.serial_number, selection.battery_serial!))
      .limit(1);
    const warrantyId = asset?.id ?? null;
    const warrantyEnd = asset?.warranty_end_date ?? null;

    // Post-commit notifications
    if (warrantyId) {
      notifyDelivered({
        leadId,
        warrantyId,
        batterySerial: selection.battery_serial!,
        source: "manual",
      }).catch(() => {});
    }

    const customerPhone = lead.phone || lead.mobile;
    if (customerPhone) {
      const warrantyEndStr = warrantyEnd
        ? new Date(warrantyEnd).toISOString().slice(0, 10)
        : "—";
      sendKycSms({
        mobile_number: customerPhone,
        message: `Welcome to iTarang! Your battery ${selection.battery_serial} delivery is confirmed. Warranty ${warrantyId ?? "—"} valid through ${warrantyEndStr}. Reach support: support@itarang.com`,
        reference_id: `delivered-${leadId}-${Date.now()}`,
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      data: {
        leadStatus: "sold",
        warrantyId,
        warrantyEnd: warrantyEnd ? new Date(warrantyEnd).toISOString() : null,
        inventoryFlipped: result.changed,
        message: "Delivery confirmed. Sale finalized.",
      },
    });
  } catch (error) {
    console.error("[Mark Delivered] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to mark delivered";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}

