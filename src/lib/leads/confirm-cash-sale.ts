/**
 * Cash sale confirmation — the transaction, lifted out of the dealer route.
 *
 * BRD V2 §2.5. One transaction closes the whole sale:
 *   - any leftover draft `product_selections` row is cleared
 *   - a `product_selections` row is written `admin_decision='dealer_confirmed'`
 *     (there is NO admin approval step on the cash path)
 *   - `finalizeSale({ phase: "sold" })` moves the battery (and charger)
 *     available → SOLD, creates the warranty and the after-sales record
 *   - the lead closes: `kyc_status='sold'`, `sold_at` stamped
 *
 * WHY IT LIVES HERE. A cash sale can now be completed from a WhatsApp turn,
 * which has no Supabase session for `requireRole("dealer")`. This is the second
 * place stock and money move (the first is `confirm-dispatch.ts`), so it gets
 * the same treatment: exactly one implementation, both callers reach it.
 *
 * CASH SKIPS 'dispatched' ENTIRELY — inventory goes straight to 'sold' on
 * confirmation (BRD §3.5). That is why there is no OTP anywhere on this path and
 * why a cash lead never reaches Step 5.
 *
 * The `payment_method` check is NOT authorisation and stays here: a lead whose
 * method collapses to 'finance' must never be closed as a cash sale, whoever is
 * asking.
 */

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { inventory, leads, productSelections } from "@/lib/db/schema";
import { generateId } from "@/lib/api-utils";
import { finalizeSale } from "@/lib/sales/sale-finalization";
import { toPaymentMode } from "@/lib/sales/payment-mode";
import { notifyProductSelectionSubmitted } from "@/lib/notifications";
import { notifyFulfilmentToAdmin } from "@/lib/notifications/events";

/** A refusal the caller should show verbatim, with the status to return. */
export class CashSaleError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "CashSaleError";
    this.status = status;
  }
}

/** Everything `product_selections` can carry on a cash sale. */
export interface CashSaleBody {
  batterySerial: string;
  chargerSerial?: string | null;
  paraphernalia?: Record<string, string | number>;
  paraphernaliaLines?: unknown[];
  dealerMargin: number;
  dealerMarginGstPercent?: number;
  dealerMarginGstAmount?: number;
  finalPrice: number;
  batteryPrice?: number;
  chargerPrice?: number;
  paraphernaliaCost?: number;
  batteryGross?: number;
  batteryGstPercent?: number;
  batteryGstAmount?: number;
  batteryNet?: number;
  chargerGross?: number;
  chargerGstPercent?: number;
  chargerGstAmount?: number;
  chargerNet?: number;
  grossSubtotal?: number;
  gstSubtotal?: number;
  netSubtotal?: number;
  category?: string;
  modelNumber?: string;
  batteryPhotoUrls?: string[];
  chargerPhotoUrls?: string[];
}

export interface CashSaleResult {
  leadStatus: "sold";
  productSelectionId: string;
  warrantyId: string;
  warrantyStart: Date;
  warrantyEnd: Date;
  warrantyMonths: number;
  afterSalesId: string;
  paymentMode: "cash";
  batterySerial: string;
}

/**
 * Close a cash sale.
 *
 * The caller owns authorisation and lead ownership. Throws `CashSaleError` for
 * anything the seller should be told about — including stock that was taken
 * between the pick and the confirm, which is the one failure a chat flow has to
 * recover from rather than swallow.
 */
export async function confirmCashSale(opts: {
  leadId: string;
  body: CashSaleBody;
  /** `users.id` recorded as the performer on every row this writes. */
  performedBy: string;
  /** The dealer that owns the stock — checked against each serial. */
  dealerId: string;
}): Promise<CashSaleResult> {
  const { leadId, body, performedBy, dealerId } = opts;

  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) throw new CashSaleError("Lead not found", 404);

  // E-101: collapse the 3-value leads.payment_method through the canonical
  // utility — never inline. 'other_finance' collapses to 'finance' and is
  // therefore correctly refused here.
  let paymentMode: "cash" | "finance";
  try {
    paymentMode = toPaymentMode(lead.payment_method);
  } catch (e) {
    throw new CashSaleError(
      e instanceof Error ? e.message : "Unrecognised payment_method on lead",
    );
  }
  if (paymentMode !== "cash") {
    throw new CashSaleError(
      "Not a cash lead — use submit-product-selection for finance",
    );
  }

  const productSelectionId = await generateId("PS");
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    // 1. Race-condition guards on inventory. A serial taken between the pick
    //    and this confirm must fail here, not half-way through finalizeSale.
    const [battery] = await tx
      .select()
      .from(inventory)
      .where(
        and(
          eq(inventory.serial_number, body.batterySerial),
          eq(inventory.dealer_id, dealerId),
        ),
      )
      .limit(1);
    if (!battery || battery.status !== "available") {
      throw new CashSaleError(`Battery ${body.batterySerial} is not available`, 409);
    }
    if (body.chargerSerial) {
      const [charger] = await tx
        .select()
        .from(inventory)
        .where(
          and(
            eq(inventory.serial_number, body.chargerSerial),
            eq(inventory.dealer_id, dealerId),
          ),
        )
        .limit(1);
      if (!charger || charger.status !== "available") {
        throw new CashSaleError(`Charger ${body.chargerSerial} is not available`, 409);
      }
    }

    // Clear any existing draft so this lead disappears from /My Drafts.
    await tx
      .delete(productSelections)
      .where(
        and(
          eq(productSelections.lead_id, leadId),
          eq(productSelections.admin_decision, "draft"),
        ),
      );

    // 2. Product selection — dealer_confirmed immediately (no admin step).
    await tx.insert(productSelections).values({
      id: productSelectionId,
      lead_id: leadId,
      battery_serial: body.batterySerial,
      charger_serial: body.chargerSerial ?? null,
      paraphernalia: body.paraphernalia ?? {},
      paraphernalia_lines: body.paraphernaliaLines ?? [],
      category: body.category || lead.product_category_id,
      model_number: body.modelNumber || lead.product_type_id,
      battery_price: body.batteryPrice?.toString(),
      charger_price: body.chargerPrice?.toString(),
      paraphernalia_cost: body.paraphernaliaCost?.toString(),
      dealer_margin: body.dealerMargin.toString(),
      dealer_margin_gst_percent: body.dealerMarginGstPercent?.toString(),
      dealer_margin_gst_amount: body.dealerMarginGstAmount?.toString(),
      final_price: body.finalPrice.toString(),
      battery_gross: body.batteryGross?.toString(),
      battery_gst_percent: body.batteryGstPercent?.toString(),
      battery_gst_amount: body.batteryGstAmount?.toString(),
      battery_net: body.batteryNet?.toString(),
      charger_gross: body.chargerGross?.toString(),
      charger_gst_percent: body.chargerGstPercent?.toString(),
      charger_gst_amount: body.chargerGstAmount?.toString(),
      charger_net: body.chargerNet?.toString(),
      gross_subtotal: body.grossSubtotal?.toString(),
      gst_subtotal: body.gstSubtotal?.toString(),
      net_subtotal: body.netSubtotal?.toString(),
      payment_mode: "cash",
      admin_decision: "dealer_confirmed",
      // E-130 / Addendum V0.1 §5.1 — dealer-captured photos (cash path).
      battery_photo_urls: body.batteryPhotoUrls ?? [],
      charger_photo_urls: body.chargerPhotoUrls ?? [],
      submitted_by: performedBy,
      submitted_at: now,
      created_at: now,
      updated_at: now,
    });

    // 3. Finalize sale: inventory sold + warranty + after-sales. `paymentMode`
    //    comes from the E-101 canonical mapping above — not a hard-coded
    //    literal — so warranty and after-sales rows always reflect the lead's
    //    collapsed payment_method.
    const sale = await finalizeSale({
      tx,
      leadId,
      batterySerial: body.batterySerial,
      chargerSerial: body.chargerSerial ?? null,
      dealerId,
      customerName: lead.full_name || lead.owner_name || null,
      customerPhone: lead.phone || lead.mobile || null,
      paymentMode,
      performedBy,
      soldAt: now,
      phase: "sold",
    });

    // 4. Close the lead.
    await tx
      .update(leads)
      .set({ kyc_status: "sold", sold_at: now, updated_at: now })
      .where(eq(leads.id, leadId));

    return sale;
  });

  // Post-commit, best-effort: the sale is committed and must not be undone by a
  // messaging failure.
  notifyProductSelectionSubmitted({
    leadId,
    productSelectionId,
    paymentMode,
    finalPrice: body.finalPrice,
  }).catch(() => {});

  // The admin mirror — a completed cash sale closes the lead outright, and
  // there is otherwise no signal of it outside the dealer's own bell.
  await notifyFulfilmentToAdmin({ leadId, event: "cash_sale" }).catch(() => {});

  return {
    leadStatus: "sold",
    productSelectionId,
    warrantyId: result.warrantyId,
    warrantyStart: result.warrantyStart,
    warrantyEnd: result.warrantyEnd,
    warrantyMonths: result.warrantyMonths,
    afterSalesId: result.afterSalesId,
    paymentMode,
    batterySerial: body.batterySerial,
  };
}
