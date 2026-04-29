import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, productCategories, products } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";

// BRD V2 Part E §2.1 — access gate for Step 4 Product Selection.
//   Finance path: allowed only when kyc_status is step_3_cleared or kyc_approved
//   Cash path:    allowed immediately after Step 1 when payment_method='cash'
//   Otherwise:    blocked, with a redirectTo pointing at the last valid step.

const FINANCE_UNLOCKED = new Set(["step_3_cleared", "kyc_approved"]);
const STEP_3_STATES = new Set([
  "awaiting_additional_docs",
  "awaiting_co_borrower_kyc",
  "awaiting_co_borrower_replacement",
  "awaiting_doc_reupload",
  "awaiting_both",
  "pending_itarang_reverification",
]);
// Step 3 has been submitted but admin hasn't decided yet. BRD blocks
// editing until admin clears, but the dealer can preview Step 4 in
// read-only mode by clicking the progress arrow forward.
const STEP_3_AWAITING_ADMIN_STATES = new Set([
  "pending_itarang_verification",
  "pending_itarang_reverification",
  "awaiting_additional_docs",
  "awaiting_co_borrower_kyc",
  "awaiting_co_borrower_replacement",
  "awaiting_doc_reupload",
  "awaiting_both",
]);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireRole(["dealer"]);
    const { id: leadId } = await params;

    const [lead] = await db
      .select({
        id: leads.id,
        dealer_id: leads.dealer_id,
        full_name: leads.full_name,
        payment_method: leads.payment_method,
        kyc_status: leads.kyc_status,
        product_category_id: leads.product_category_id,
        product_type_id: leads.product_type_id,
        primary_product_id: leads.primary_product_id,
      })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);

    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }

    const paymentMode = String(lead.payment_method || "").toLowerCase();
    const kycStatus = String(lead.kyc_status || "");
    const customerName = lead.full_name || null;

    // Resolve category id → human-readable name when possible. The
    // inventory APIs still filter by id (we keep `category` as the id
    // for back-compat); `categoryName` is added purely for display.
    let categoryName: string | null = null;
    if (lead.product_category_id) {
      const [cat] = await db
        .select({ name: productCategories.name })
        .from(productCategories)
        .where(eq(productCategories.id, lead.product_category_id))
        .limit(1);
      if (cat) categoryName = cat.name;
    }

    // Step 1's "Product Type" dropdown writes lead.primary_product_id
    // (FK → products.id). lead.product_type_id remains unused. Resolve
    // primary_product_id → display name + sku so Step 4 can show the
    // exact product chosen at Step 1 and filter inventory by it.
    let productTypeName: string | null = null;
    let productSku: string | null = null;
    if (lead.primary_product_id) {
      const [prod] = await db
        .select({
          name: products.name,
          sku: products.sku,
          voltage_v: products.voltage_v,
          capacity_ah: products.capacity_ah,
        })
        .from(products)
        .where(eq(products.id, lead.primary_product_id))
        .limit(1);
      if (prod) {
        const specs = [
          prod.voltage_v ? `${prod.voltage_v}V` : null,
          prod.capacity_ah ? `${prod.capacity_ah}Ah` : null,
        ]
          .filter(Boolean)
          .join(" / ");
        productTypeName = specs ? `${prod.name} — ${specs}` : prod.name;
        productSku = prod.sku;
      }
    }

    const sharedFields = {
      dealerId: lead.dealer_id,
      customerName,
      category: lead.product_category_id,
      categoryName,
      productId: lead.primary_product_id,
      productTypeName,
      productSku,
    };

    // Cash path — unlocked right after Step 1
    if (paymentMode === "cash") {
      return NextResponse.json({
        success: true,
        data: {
          allowed: true,
          paymentMode: "cash",
          ...sharedFields,
          kycStatus,
        },
      });
    }

    // Finance path — requires KYC cleared
    if (FINANCE_UNLOCKED.has(kycStatus)) {
      return NextResponse.json({
        success: true,
        data: {
          allowed: true,
          paymentMode: "finance",
          ...sharedFields,
          kycStatus,
        },
      });
    }

    // Post-Step-4 states: still consider Step 4 "open" for viewing the
    // submitted product — but read-only. Client decides rendering.
    if (
      kycStatus === "pending_final_approval" ||
      kycStatus === "loan_sanctioned" ||
      kycStatus === "loan_rejected"
    ) {
      return NextResponse.json({
        success: true,
        data: {
          allowed: true,
          paymentMode: "finance",
          ...sharedFields,
          readOnly: true,
          kycStatus,
        },
      });
    }

    // Step 3 submitted, admin review still pending. Dealer can preview
    // Step 4 in read-only mode but cannot submit until admin clears KYC.
    if (STEP_3_AWAITING_ADMIN_STATES.has(kycStatus)) {
      return NextResponse.json({
        success: true,
        data: {
          allowed: true,
          paymentMode: "finance",
          ...sharedFields,
          readOnly: true,
          kycStatus,
          reason:
            "Step 3 is under admin review. Step 4 is preview-only until KYC is approved.",
        },
      });
    }

    // Redirect routing
    let redirectTo = `/dealer-portal/leads/${leadId}`;
    if (STEP_3_STATES.has(kycStatus)) {
      redirectTo = `/dealer-portal/leads/${leadId}/kyc/interim`;
    } else if (kycStatus === "not_started" || kycStatus === "draft" || kycStatus === "in_progress") {
      redirectTo = `/dealer-portal/leads/${leadId}/kyc`;
    } else if (kycStatus === "kyc_rejected" || kycStatus === "sold") {
      redirectTo = `/dealer-portal/leads/${leadId}`;
    }

    return NextResponse.json({
      success: true,
      data: {
        allowed: false,
        redirectTo,
        kycStatus,
        reason: `Lead kyc_status=${kycStatus} does not permit Step 4 entry`,
      },
    });
  } catch (error) {
    console.error("[Step 4 Access] Error:", error);
    const message = error instanceof Error ? error.message : "Access check failed";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
