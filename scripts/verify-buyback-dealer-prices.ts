// Read-only: every buyback deal past dealer acceptance must have an accepted
// dealer price on EVERY line at its current offer version.
//
//   node --import tsx --env-file=.env.local scripts/verify-buyback-dealer-prices.ts
//
// A line with a NULL dealer_price is what made the Margin & Routing tab show a
// ₹8,11,931 order as ₹0: the review-bar Accept used to flip the status without
// writing the ACCEPTED final offer that linesForRequest reads the price from.
// Fixed in acceptDealerAsk (src/lib/buyback/dealer-accept.ts). Requests stuck
// before the fix are repaired by scripts/repair-buyback-unpriced-accepts.ts.
// Writes nothing. Exit 1 if any deal is unpriced.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { linesForRequest } from "@/lib/buyback/queries";
import { DEAL_STATES } from "@/lib/buyback/state-machine";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

// Everything from DEALER_ACCEPTED up to (not including) the terminal states.
const from = DEAL_STATES.indexOf("DEALER_ACCEPTED");
const PRICED_STATES = DEAL_STATES.slice(from).filter(
  (s) => s !== "REJECTED" && s !== "CANCELLED" && s !== "DEALER_REOPENED",
);

async function main() {
  console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}\n`);
  const deals = rowsOf<{ request_id: string; request_no: string; status: string; offer_version: number }>(
    await db.execute(sql`
      SELECT r.id::text AS request_id, r.request_no, bd.status, bd.offer_version
      FROM buyback_deals bd
      JOIN buyback_requests r ON r.id = bd.request_id
      WHERE bd.status::text IN (${sql.join(PRICED_STATES.map((s) => sql`${s}`), sql`, `)})
      ORDER BY r.created_at
    `),
  );

  let bad = 0;
  for (const d of deals) {
    const lines = await linesForRequest(d.request_id);
    const unpriced = lines.filter((l) => l.dealer_price == null);
    if (unpriced.length === 0) continue;
    bad++;
    const ask = lines.reduce((s, l) => s + l.quantity * Number(l.expected_price_per_unit ?? 0), 0);
    console.log(
      `UNPRICED  ${d.request_no}  ${d.status} v${d.offer_version}  ${unpriced.length}/${lines.length} lines  dealer ask total ₹${ask.toLocaleString("en-IN")}  (${d.request_id})`,
    );
  }

  console.log(`\n${deals.length} deal(s) past dealer acceptance checked · ${bad} unpriced`);
  process.exit(bad > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
