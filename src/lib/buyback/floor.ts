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
