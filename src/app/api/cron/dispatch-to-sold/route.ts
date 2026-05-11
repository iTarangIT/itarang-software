import { and, desc, eq, inArray, lt } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  deployedAssets,
  inventory,
  leads,
  productSelections,
} from "@/lib/db/schema";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { checkCronAuth } from "@/lib/cron-auth";
import { markDispatchedAsSold } from "@/lib/sales/sale-finalization";
import { notifyDelivered } from "@/lib/notifications";
import { sendKycSms } from "@/lib/sms";

// BRD V2 §3.5 — daily cron that auto-finalises any lead stuck in 'dispatched'
// once the configurable delay (default 1 day) has elapsed since its inventory
// was dispatched. Mirrors the manual /mark-delivered logic.
//
// Auth: Bearer ${CRON_SECRET}. In dev (NODE_ENV !== 'production') we relax
// the gate so localhost curl tests work. Pattern matches cleanup-leads.
//
// Schedule: registered in vercel.json. Run at 04:00 UTC daily.

export const GET = withErrorHandler(async (req: Request) => {
  // Dev still allows unauthenticated localhost calls for testing — only the
  // env-var-missing case is hardened relative to before. In production an
  // unset CRON_SECRET now returns 500, not 200.
  if (process.env.NODE_ENV === "production") {
    const unauth = checkCronAuth(req);
    if (unauth) return unauth;
  }

  const days = Number(process.env.DISPATCH_TO_SOLD_DAYS ?? "1");
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Find inventory rows that have been in 'dispatched' state past the cutoff,
  // grouped by their linked lead.
  const ripeRows = await db
    .select({
      lead_id: inventory.linked_lead_id,
      serial_number: inventory.serial_number,
      asset_category: inventory.asset_category,
      dispatch_date: inventory.dispatch_date,
    })
    .from(inventory)
    .where(
      and(
        eq(inventory.status, "dispatched"),
        lt(inventory.dispatch_date, cutoff),
      ),
    );

  if (ripeRows.length === 0) {
    return successResponse({ count: 0, leadsProcessed: [], cutoff: cutoff.toISOString() });
  }

  // Cross-check leads — only act on leads still in kyc_status='dispatched'.
  // Anything already 'sold' (e.g. dealer beat us to Mark Delivered) is skipped.
  const leadIds = [
    ...new Set(ripeRows.map((r) => r.lead_id).filter((x): x is string => !!x)),
  ];
  const leadRows = await db
    .select()
    .from(leads)
    .where(
      and(
        inArray(leads.id, leadIds),
        eq(leads.kyc_status, "dispatched"),
      ),
    );

  const processed: string[] = [];
  const now = new Date();

  for (const lead of leadRows) {
    try {
      // Pull the latest selection so we know which battery + charger pair to
      // flip. The cron does NOT trust inventory.linked_lead_id alone because
      // a lead might have multiple inventory rows (battery + charger) and we
      // need both to flip atomically.
      const [selection] = await db
        .select()
        .from(productSelections)
        .where(eq(productSelections.lead_id, lead.id))
        .orderBy(desc(productSelections.created_at))
        .limit(1);
      if (!selection || !selection.battery_serial || !selection.charger_serial) {
        continue;
      }

      await db.transaction(async (tx) => {
        await markDispatchedAsSold({
          tx,
          leadId: lead.id,
          batterySerial: selection.battery_serial!,
          chargerSerial: selection.charger_serial!,
          performedBy: lead.dealer_id ?? "cron",
          soldAt: now,
        });

        await tx
          .update(leads)
          .set({ kyc_status: "sold", sold_at: now, updated_at: now })
          .where(eq(leads.id, lead.id));
      });

      processed.push(lead.id);

      // Post-commit fire-and-forget notifications
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

      if (warrantyId) {
        notifyDelivered({
          leadId: lead.id,
          warrantyId,
          batterySerial: selection.battery_serial!,
          source: "cron",
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
          reference_id: `cron-delivered-${lead.id}-${Date.now()}`,
        }).catch(() => {});
      }
    } catch (err) {
      console.error(
        `[Cron dispatch-to-sold] Failed lead ${lead.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return successResponse({
    count: processed.length,
    leadsProcessed: processed,
    cutoff: cutoff.toISOString(),
    dispatchToSoldDays: days,
  });
});
