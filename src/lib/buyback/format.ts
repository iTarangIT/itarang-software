/**
 * peakAmp — THE shared battery-line formatter (BRD M02, invariant 7).
 *
 * "ONE shared battery-line summary formatter component used everywhere — the
 *  prototype's `[object Object]` bug came from per-screen templates."
 *
 * So: do not build a battery-line string anywhere else. Import from here.
 *
 * The core function returns STRUCTURED PARTS, never a pre-concatenated string.
 * That is deliberate — the prototype's `lineSpec()` returned a string and then
 * (a) got interpolated with an object, producing `[object Object]`, and (b) got
 * reused as a map key and a DOM id, so two lines with the same SKU + condition
 * silently collided. Callers that need a key use `line.id`; callers that need
 * pixels render <BatteryLineLabel/>.
 */

export type BatteryCondition = "WORKING" | "DEAD";

/** The minimum a caller must supply. Any row with these fields formats. */
export interface FormattableLine {
  id: string;
  quantity: number;
  condition: BatteryCondition;
  /** Nominal spec off the catalog variant. */
  voltage: number | string;
  ah: number | string;
}

export interface FormattedBatteryLine {
  /** "60V 120Ah" — nominal spec, never the measured voltage. */
  specLabel: string;
  /** "Working" | "Dead" — title case, for the chip. */
  condition: string;
  /** The raw enum, for styling the chip. */
  conditionKey: BatteryCondition;
  /** The quantity. */
  count: number;
  /** "×3" — U+00D7, no space before the digits (matches the design). */
  countLabel: string;
  /**
   * "60V 120Ah · Working ×3" — the full human label, for places that genuinely
   * need one string (PDF cells, WhatsApp bodies, aria-labels). UI should prefer
   * the parts so the condition can render as a coloured chip.
   */
  full: string;
}

/** Trims a trailing ".00" so 60.00 → "60" but 51.20 → "51.2". */
function trimNumber(value: number | string): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return String(value);
  return String(Number(n.toFixed(2)));
}

export function formatBatteryLine(line: FormattableLine): FormattedBatteryLine {
  const specLabel = `${trimNumber(line.voltage)}V ${trimNumber(line.ah)}Ah`;
  const condition = line.condition === "DEAD" ? "Dead" : "Working";
  const countLabel = `×${line.quantity}`;

  return {
    specLabel,
    condition,
    conditionKey: line.condition,
    count: line.quantity,
    countLabel,
    // U+00B7 MIDDLE DOT with spaces, per the design handoff.
    full: `${specLabel} · ${condition} ${countLabel}`,
  };
}

/**
 * Indian-grouped rupees: 53200 → "₹53,200". Null/NaN → "—" (an em dash, never
 * "₹NaN" or "₹0" — a missing price and a zero price are different things).
 * Fractions are dropped: every price in this system is whole rupees per unit.
 */
export function inr(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";

  const negative = n < 0;
  const formatted = new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 0,
  }).format(Math.abs(Math.round(n)));

  return `${negative ? "-" : ""}₹${formatted}`;
}

/** "₹5,200/unit" — for the big, unambiguous places (offer panels, vendor board). */
export function perUnit(value: number | string | null | undefined): string {
  const amount = inr(value);
  return amount === "—" ? amount : `${amount}/unit`;
}

/** "₹5,200/u" — the compact form used inside dense tables and chat bubbles. */
export function perUnitShort(value: number | string | null | undefined): string {
  const amount = inr(value);
  return amount === "—" ? amount : `${amount}/u`;
}

/** Line total = qty × price/unit. Returns null when the price is unknown. */
export function lineTotal(
  quantity: number,
  pricePerUnit: number | string | null | undefined,
): number | null {
  if (pricePerUnit === null || pricePerUnit === undefined || pricePerUnit === "") return null;
  const n = typeof pricePerUnit === "string" ? Number(pricePerUnit) : pricePerUnit;
  if (!Number.isFinite(n)) return null;
  return quantity * n;
}
