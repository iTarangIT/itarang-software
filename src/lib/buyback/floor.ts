/**
 * The floor (M08 / M10).
 *
 * `buyback_deals.floor_total` is set when the margin is locked: it is
 * Σ qty × (dealer_price + margin) — the least iTarang can sell the lot for and
 * still earn the margin it committed to.
 *
 * Two guards use it, and the difference matters:
 *
 *   · ROUTING (M08: "floor blocks routing below breakeven") — we must not ASK a
 *     vendor for less than the floor. That is arithmetic, not judgement: the ask
 *     IS dealer_price + margin, so it can only fall below the floor if the locks
 *     and the floor disagree, which means something is corrupt. Checked anyway,
 *     because silently quoting below breakeven is the expensive failure.
 *
 *   · AGREEMENT (M10: "below floor → Reopen dealer leg") — a vendor countered
 *     below what we need. This is the one that happens in the real world, and it
 *     is REFUSED, not warned about. The design prototype shows a red banner and
 *     then lets the admin agree anyway; that turns a deliberate business rule
 *     into a suggestion. The only way forward is to reopen the dealer leg and
 *     renegotiate the price we pay — which is exactly what BRD §2's
 *     "below floor → DEALER_REOPENED" prescribes.
 */

import { ValidationError } from "./errors";
import { inr } from "./format";

export interface FloorCheckLine {
  line_id: string;
  quantity: number;
  price: number | string | null;
}

export interface FloorCheck {
  ok: boolean;
  total: number;
  floor: number;
  shortfall: number;
}

export function totalOf(lines: FloorCheckLine[]): number {
  return lines.reduce((sum, l) => sum + l.quantity * Number(l.price ?? 0), 0);
}

/**
 * The dealer's accepted price for a line, or a refusal — the number the floor
 * is built ON, validated before anything is built on it.
 *
 * Pure, and here rather than inline in margin/route.ts, because the route
 * imports the db and a guard you cannot test without a database is a guard
 * nobody tests. This one was wrong for exactly that long.
 *
 * WHAT IT IS DEFENDING AGAINST. The route wrote:
 *
 *     const dealerPrice = Number(line.dealer_price);
 *     if (!Number.isFinite(dealerPrice)) throw ...
 *
 * which reads as "reject a price that isn't a number". It isn't. `Number(null)`
 * is `0` and `Number.isFinite(0)` is `true`, so an UNPRICED line sailed through
 * and was locked at ₹0 into deal_line_locks — a table that is INSERT-only and
 * fill-once. The dealer's own price for that deal became permanently zero, the
 * floor collapsed to margin alone, and nothing anywhere said a word.
 *
 * A null price and a zero price are different facts and must fail differently:
 * null means nobody has agreed a price yet, zero means someone agreed a
 * nonsensical one. Both are refusals; conflating them is what hid the bug.
 */
export function resolveDealerPrice(
  price: number | string | null | undefined,
): { ok: true; price: number } | { ok: false; reason: "missing" | "unusable"; raw: string } {
  if (price === null || price === undefined || price === "") {
    return { ok: false, reason: "missing", raw: String(price) };
  }

  const n = Number(price);
  // <= 0 is "unusable", not "missing": a real zero got written by something, and
  // buying a battery for nothing is not a price anyone negotiated.
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, reason: "unusable", raw: String(price) };
  }

  return { ok: true, price: n };
}

export function checkFloor(lines: FloorCheckLine[], floorTotal: number | string | null): FloorCheck {
  const total = totalOf(lines);
  const floor = Number(floorTotal ?? 0);

  return {
    ok: total >= floor,
    total,
    floor,
    shortfall: Math.max(0, floor - total),
  };
}

/**
 * Refuse a vendor agreement that does not clear the floor.
 *
 * A 422 with the numbers in it, not a bare "not allowed": the admin needs to
 * know how far short the vendor is to decide whether to push them or reopen the
 * dealer leg.
 */
export function assertClearsFloor(
  lines: FloorCheckLine[],
  floorTotal: number | string | null,
): FloorCheck {
  const check = checkFloor(lines, floorTotal);

  if (!check.ok) {
    throw new ValidationError(
      `This vendor's total of ${inr(check.total)} is ${inr(check.shortfall)} below the floor of ` +
        `${inr(check.floor)}. Agreeing would sell the lot for less than iTarang has committed to ` +
        `pay the dealer plus margin. Push the vendor, or reopen the dealer leg to renegotiate.`,
      {
        code: "BELOW_FLOOR",
        total: check.total,
        floor: check.floor,
        shortfall: check.shortfall,
      },
    );
  }

  return check;
}
