/**
 * The pickup variance calculation (M05) — PURE.
 *
 * Split out of pickup.ts, which imports the database. This is the half that
 * decides whether a dealer's money is held, so it must be testable without a DB
 * connection: a rule this expensive to get wrong should not be untestable because
 * of an import.
 *
 * A variance means we counted fewer batteries — or fewer WORKING ones — than the
 * dealer declared. That changes what we owe. Paying out first and arguing
 * afterwards means arguing about money that has already left the building.
 */

/** What the dealer said they had, per line. */
export interface ExpectedCount {
  line_id: string;
  label: string;
  quantity: number;
}

/** What we actually collected, per line. */
export interface ActualCount {
  line_id: string;
  quantity: number;
}

export interface LineVariance {
  line_id: string;
  label: string;
  expected: number;
  actual: number;
  /** Negative = short. Positive = the dealer handed over MORE than they declared. */
  delta: number;
}

export interface VarianceResult {
  hasVariance: boolean;
  lines: LineVariance[];
  totalExpected: number;
  totalActual: number;
  summary: string | null;
}

export function computeVariance(
  expected: ExpectedCount[],
  actual: ActualCount[],
): VarianceResult {
  const byLine = new Map(actual.map((a) => [a.line_id, a.quantity]));

  const lines: LineVariance[] = expected.map((e) => {
    // An OMITTED line is zero received, not "no data". Reading a missing line as
    // "assume fine" would pay for batteries nobody ever saw.
    const got = byLine.get(e.line_id) ?? 0;
    return {
      line_id: e.line_id,
      label: e.label,
      expected: e.quantity,
      actual: got,
      delta: got - e.quantity,
    };
  });

  const off = lines.filter((l) => l.delta !== 0);
  const totalExpected = lines.reduce((s, l) => s + l.expected, 0);
  const totalActual = lines.reduce((s, l) => s + l.actual, 0);

  // Note this is computed PER LINE, never on the total. Two short working
  // batteries and two extra dead ones nets to zero — and would have us paying the
  // working price for dead cells.
  const summary =
    off.length === 0
      ? null
      : off
          .map((l) => `${l.label}: ${l.delta < 0 ? "short by" : "over by"} ${Math.abs(l.delta)}`)
          .join("; ");

  return { hasVariance: off.length > 0, lines, totalExpected, totalActual, summary };
}
