/**
 * "🔋 Active batteries" — the dealer console's view of what they have already
 * put in customers' hands.
 *
 * Inventory answers "what can I sell?"; this answers "what have I sold, to
 * whom, and how long is it covered?". The source is `deployed_assets`, the one
 * table that carries owner name + phone + warranty dates + dealer on a single
 * row (written by `finalizeSale` for both the cash close and the finance
 * dispatch). Same root as `/api/dealer/assets`, filtered the same way — a
 * dealer sees only rows with their own `dealer_id`.
 *
 * TWO MESSAGES, NOT ONE. A WhatsApp list row holds 24 + 72 characters, which
 * is enough for "which battery, whose" but not for a warranty and a phone
 * number. So the list is a picker and a tap sends the full card, after which
 * the list is shown again so the dealer can keep browsing. Paging reuses the
 * `stock-rows` constants (10-row Meta cap, one reserved for "Show more").
 *
 * The lead id is joined in from `after_sales_records`: `finalizeSale` writes
 * `deployed_assets.lead_id` as NULL on purpose (a varchar-vs-FK mismatch), and
 * that table is the documented way back to the lead.
 */

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { afterSalesRecords, deployedAssets } from "@/lib/db/schema";

import type { ActiveDealer } from "./customer-lead";
import { mergeContext, reply, replyList, setSession, type SessionRow } from "./session-store";
import {
  activeBatteryCard,
  activeBatteryRows,
  type ActiveBattery,
} from "./active-battery-rows";
import { PAGE_SIZE } from "./stock-rows";
import type { InboundEvent } from "./types";

export type { ActiveBattery } from "./active-battery-rows";
export { activeBatteryCard, activeBatteryRows, warrantyMonthsOf } from "./active-battery-rows";

export const DC_ACTIVE_BATT = "DC_ACTIVE_BATT";

const ROW_PREFIX = "ab";

export async function listActiveBatteries(dealerCode: string): Promise<ActiveBattery[]> {
  const rows = await db
    .select({
      warrantyId: deployedAssets.id,
      serial: deployedAssets.serial_number,
      model: deployedAssets.model_type,
      category: deployedAssets.asset_category,
      customerName: deployedAssets.customer_name,
      customerPhone: deployedAssets.customer_phone,
      deployedAt: deployedAssets.deployment_date,
      warrantyStart: deployedAssets.warranty_start_date,
      warrantyEnd: deployedAssets.warranty_end_date,
      warrantyMonths: deployedAssets.warranty_months,
      paymentType: deployedAssets.payment_type,
      paymentStatus: deployedAssets.payment_status,
      leadId: afterSalesRecords.lead_id,
    })
    .from(deployedAssets)
    .leftJoin(afterSalesRecords, eq(afterSalesRecords.warranty_id, deployedAssets.id))
    .where(and(eq(deployedAssets.dealer_id, dealerCode), eq(deployedAssets.status, "active")))
    .orderBy(desc(deployedAssets.deployment_date));

  return rows
    .filter((r): r is typeof r & { serial: string } => Boolean(r.serial))
    .map((r) => ({ ...r, serial: r.serial }));
}

// ---------------------------------------------------------------------------
// Console handlers
// ---------------------------------------------------------------------------

/** Menu entry: list the dealer's active batteries (page 0). */
export async function showActiveBatteries(
  session: SessionRow,
  dealer: ActiveDealer,
  page = 0,
): Promise<void> {
  const items = await listActiveBatteries(dealer.dealerCode);

  if (items.length === 0) {
    await setSession(session.id, { current_state: "DC_MENU" });
    await reply(
      session,
      "🔋 No batteries dispatched yet.\n\nOnce you confirm a sale or a dispatch, it will show up here.\n\nSend *menu* to go back.",
    );
    return;
  }

  // Clamp: the list may have shrunk since the page cursor was written.
  const lastPage = Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1);
  const p = Math.min(Math.max(0, page), lastPage);

  await mergeContext(session, (ctx) => {
    ctx.ab = { page: p };
  });
  await setSession(session.id, { current_state: DC_ACTIVE_BATT });
  await replyList(
    session,
    `🔋 *Active batteries* — ${items.length} in customers' hands\n\n` +
      `Tap one for the owner and warranty details.\n\n_Send *menu* to go back._`,
    "Pick a battery",
    activeBatteryRows(items, p),
  );
}

/** DC_ACTIVE_BATT — a tapped row, "Show more", or stray text. */
export async function onActiveBatteryPick(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const raw = (event.text ?? "").trim();
  const ctx = (session.context ?? {}) as { ab?: { page?: number } };
  const page = ctx.ab?.page ?? 0;

  if (raw === `${ROW_PREFIX}_more`) {
    return await showActiveBatteries(session, dealer, page + 1);
  }

  const m = raw.match(new RegExp(`^${ROW_PREFIX}:(.+)$`));
  if (!m) {
    // Not one of our rows — re-render the same page rather than guess.
    return await showActiveBatteries(session, dealer, page);
  }

  const serial = m[1].trim();
  const items = await listActiveBatteries(dealer.dealerCode);
  const hit = items.find((b) => b.serial === serial);
  if (!hit) {
    await reply(session, "I couldn't find that battery any more. Here's the current list:");
    return await showActiveBatteries(session, dealer, 0);
  }

  await reply(session, activeBatteryCard(hit));
  // Keep browsing from the same page.
  await showActiveBatteries(session, dealer, page);
}
