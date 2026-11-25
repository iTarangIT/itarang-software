// Repair buyback deals stuck at DEALER_ACCEPTED with no accepted dealer price.
//
//   node --import tsx --env-file=.env.local scripts/repair-buyback-unpriced-accepts.ts            # dry run
//   node --import tsx --env-file=.env.local scripts/repair-buyback-unpriced-accepts.ts --apply    # write
//   ... --apply BB-1058                                                                            # one request only
//
// Before the fix in acceptDealerAsk (src/lib/buyback/dealer-accept.ts), the
// review-bar Accept moved a deal to DEALER_ACCEPTED without writing the ACCEPTED
// final offer that linesForRequest reads dealer_price from — so the Margin tab
// showed the order at ₹0 and margin could not be locked (e.g. BB-1058).
//
// This does what the fixed Accept now does: snapshot each line's dealer asking
// price (expected_price_per_unit) as an ACCEPTED final offer at the deal's
// current offer version. Only touches deals that are DEALER_ACCEPTED, have no
// ACCEPTED final offer and no locks at that version. A deal with any line that
// has no usable asking price is SKIPPED and reported — reopen it in the UI.
// Re-running is a no-op.

import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { finalOfferLines, finalOffers } from "@/lib/db/schema";
import { buildAskPrices } from "@/lib/buyback/floor";
import { linesForRequest } from "@/lib/buyback/queries";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

const apply = process.argv.includes("--apply");
const only = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? null;

async function main() {
  console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}  ·  ${apply ? "APPLY" : "dry run"}${only ? `  ·  ${only}` : ""}\n`);

  const deals = rowsOf<{ deal_id: string; request_id: string; request_no: string; offer_version: number }>(
    await db.execute(sql`
      SELECT bd.id::text AS deal_id, r.id::text AS request_id, r.request_no, bd.offer_version
      FROM buyback_deals bd
      JOIN buyback_requests r ON r.id = bd.request_id
      WHERE bd.status = 'DEALER_ACCEPTED'
        AND NOT EXISTS (SELECT 1 FROM final_offers fo
                         WHERE fo.deal_id = bd.id AND fo.version_no = bd.offer_version
                           AND fo.status = 'ACCEPTED')
        AND NOT EXISTS (SELECT 1 FROM deal_line_locks dll
                         WHERE dll.deal_id = bd.id AND dll.offer_version = bd.offer_version)
        ${only ? sql`AND r.request_no = ${only}` : sql``}
      ORDER BY r.created_at
    `),
  );

  let fixed = 0;
  let skipped = 0;
  for (const d of deals) {
    const lines = await linesForRequest(d.request_id);
    const ask = buildAskPrices(lines);
    if (!ask.ok) {
      skipped++;
      console.log(`SKIP  ${d.request_no}  v${d.offer_version}  — ${ask.variant_type ?? "no lines"}: asking price ${ask.reason} (${ask.raw}). Reopen the dealer leg in the UI.`);
      continue;
    }
    console.log(`${apply ? "FIX " : "WOULD FIX"}  ${d.request_no}  v${d.offer_version}  dealer total ₹${ask.total.toLocaleString("en-IN")}`);
    for (const l of lines) {
      const p = ask.prices.find((x) => x.line_id === l.id)!;
      console.log(`      ${l.variant_type} ${l.voltage}V ${l.ah}Ah ${l.condition} ×${l.quantity} @ ₹${p.price_per_unit}`);
    }
    if (!apply) continue;

    await db.transaction(async (tx) => {
      // Re-check under a row lock so a concurrent admin action can't race us.
      const locked = rowsOf<{ status: string; offer_version: number }>(
        await tx.execute(sql`SELECT status, offer_version FROM buyback_deals WHERE id = ${d.deal_id} FOR UPDATE`),
      )[0];
      if (!locked || locked.status !== "DEALER_ACCEPTED" || Number(locked.offer_version) !== Number(d.offer_version)) {
        throw new Error(`${d.request_no} changed while repairing — re-run.`);
      }
      await tx
        .delete(finalOffers)
        .where(and(eq(finalOffers.deal_id, d.deal_id), eq(finalOffers.version_no, d.offer_version), ne(finalOffers.status, "ACCEPTED")));
      const [offer] = await tx
        .insert(finalOffers)
        .values({
          deal_id: d.deal_id,
          version_no: d.offer_version,
          status: "ACCEPTED",
          note: "Repair: review Accept recorded no price; dealer's asking price snapshotted as accepted.",
          sent_by: null,
          responded_at: new Date(),
        })
        .returning({ id: finalOffers.id });
      await tx.insert(finalOfferLines).values(
        ask.prices.map((p) => ({ final_offer_id: offer.id, line_id: p.line_id, price_per_unit: String(p.price_per_unit) })),
      );
    });
    fixed++;
  }

  console.log(`\n${deals.length} stuck deal(s) · ${apply ? `${fixed} fixed` : `${deals.length - skipped} fixable`} · ${skipped} skipped`);
  if (!apply && deals.length - skipped > 0) console.log("Re-run with --apply to write.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
