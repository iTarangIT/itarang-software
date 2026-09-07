/**
 * What is actually on the table, per SKU (E-281).
 *
 * Before E-281 this was a COALESCE and did not need a name: the vendor was the
 * only party who could move a number after routing, so "the live price" was
 * `counter_price ?? ask_price` and every reader could spell that inline.
 *
 * Once iTarang can counter BACK, the live price stops being a fallback chain and
 * becomes a RECENCY question — and recency cannot be read off the columns,
 * because both sides' latest numbers sit side by side and neither is "more null"
 * than the other. `vendor_threads.awaiting_party` is the discriminator: if the
 * ball is with the VENDOR, the last thing said was ours; if it is with ITARANG,
 * the last thing said was theirs.
 *
 * THE BUG THIS EXISTS TO PREVENT. applyVendorResponse's agree branch defaulted to
 * `COALESCE(counter_price, ask_price)`. Left that way, a vendor clicking "Accept"
 * on OUR counter would have agreed to THEIR OWN earlier, lower number — which is
 * below the floor by construction (that is why we countered), so the floor guard
 * would refuse it and the vendor could not accept a price we had just offered
 * them. One rule, one file, three callers.
 *
 * `agreed_price` wins over everything: once struck, nothing is on the table.
 */

import { sql, type SQL } from "drizzle-orm";

/** Whose move it is on a thread. */
export type AwaitingParty = "VENDOR" | "ITARANG";

/**
 * The standing per-unit price as a SQL fragment, for the raw-SQL readers in
 * vendors.ts and vendor-response.ts.
 *
 * `vtl` / `vt` are the table aliases the caller has already bound — this is
 * pasted into a bigger query rather than issuing one of its own.
 */
export function standingPriceSql(vtl = "vtl", vt = "vt"): SQL {
  return sql.raw(
    `COALESCE(
       ${vtl}.agreed_price,
       CASE WHEN ${vt}.awaiting_party = 'VENDOR' THEN ${vtl}.revised_ask_price END,
       ${vtl}.counter_price,
       ${vtl}.ask_price
     )`,
  );
}

/** The same rule in TypeScript, for callers that already hold the row. */
export function standingPrice(
  line: {
    ask_price: string | number | null;
    counter_price: string | number | null;
    revised_ask_price?: string | number | null;
    agreed_price?: string | number | null;
  },
  awaitingParty: AwaitingParty,
): string | number | null {
  if (line.agreed_price != null) return line.agreed_price;
  if (awaitingParty === "VENDOR" && line.revised_ask_price != null) {
    return line.revised_ask_price;
  }
  return line.counter_price ?? line.ask_price;
}
