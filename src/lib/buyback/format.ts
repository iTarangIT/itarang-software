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

/** The E-191 spec fields a line row may carry. Everything optional/nullable. */
export interface SpecSummarySource {
  brand?: string | null;
  chemistry?: string | null;
  form_factor?: string | null;
  nominal_voltage?: number | string | null;
  nominal_ampere?: number | string | null;
  unit_weight_kg?: number | string | null;
  warranty_cycles?: number | null;
  functional_qty?: number | null;
  non_functional_qty?: number | null;
  iot_battery?: boolean | null;
  iot_brand_name?: string | null;
}

/**
 * One "·"-joined summary of the dealer-declared battery spec (E-191), for the
 * meta row under a battery line: "Exide · NMC · Prismatic · 51.2V 100Ah nom ·
 * 12.5kg/unit · 800 warranty cycles · 2 functional / 1 non-functional ·
 * IOT: BoltIoT". Fields the dealer never provided simply don't appear; a line
 * with no spec at all returns null so callers can skip the row entirely.
 *
 * Same shared-formatter rule as formatBatteryLine: do not rebuild this string
 * per screen.
 */
export function specSummary(line: SpecSummarySource): string | null {
  const parts: string[] = [];

  if (line.brand) parts.push(line.brand);
  if (line.chemistry) parts.push(line.chemistry);
  if (line.form_factor) {
    const ff = line.form_factor.toLowerCase();
    parts.push(ff.charAt(0).toUpperCase() + ff.slice(1));
  }
  if (line.nominal_voltage != null || line.nominal_ampere != null) {
    const v = line.nominal_voltage != null ? `${trimNumber(line.nominal_voltage)}V` : null;
    const a = line.nominal_ampere != null ? `${trimNumber(line.nominal_ampere)}Ah` : null;
    parts.push(`${[v, a].filter(Boolean).join(" ")} nom`);
  }
  if (line.unit_weight_kg != null) parts.push(`${trimNumber(line.unit_weight_kg)}kg/unit`);
  if (line.warranty_cycles != null) parts.push(`${line.warranty_cycles} warranty cycles`);
  if (line.functional_qty != null || line.non_functional_qty != null) {
    parts.push(
      `${line.functional_qty ?? 0} functional / ${line.non_functional_qty ?? 0} non-functional`,
    );
  }
  if (line.iot_battery === true) parts.push(`IOT: ${line.iot_brand_name || "yes"}`);
  else if (line.iot_battery === false) parts.push("Non-IOT");

  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The E-191 spec fields a VENDOR-facing line carries. Structural rather than an
 * import of VendorLineView, because serialize.ts imports this module — typing
 * the parameter by that view would close an import cycle.
 */
export interface VendorLineMetaSource {
  variant_type?: string | null;
  brand?: string | null;
  chemistry?: string | null;
  form_factor?: string | null;
  nominal_voltage?: number | string | null;
  nominal_ampere?: number | string | null;
  /** As declared, per unit. */
  unit_weight_kg?: number | string | null;
  /** qty × unit_weight_kg — the number a scrap buyer actually prices against. */
  line_weight_kg?: number | string | null;
  /** RATED life. Rendered as "rated", always — see below. */
  warranty_cycles?: number | null;
  /** "6 working · 3 non-working · 1 untested", already assembled by the serializer. */
  condition_split_label?: string | null;
  iot_battery?: boolean | null;
  /** Already carries "(assumed)" when we guessed the brand. */
  iot_brand_label?: string | null;
}

/** A declared positive quantity as a trimmed string, or null when undeclared.
 * Zero is NOT a declaration: a 0 kg battery is a blank field, and `"0.000"` is a
 * truthy string, so a plain falsy check would print it. */
function declared(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n) || n <= 0) return null;
  return trimNumber(n);
}

/**
 * THE vendor-facing battery meta line, as ORDERED PARTS (never pre-joined —
 * same reason formatBatteryLine returns parts: the PDF has to HTML-escape each
 * one, and the portal renders them into elements).
 *
 * Shared by the quotation PDF and the vendor portal. Every part is a property of
 * the BATTERY: none of it identifies who is selling, which is what makes it safe
 * to show a vendor at all.
 *
 * Undeclared fields are OMITTED, not rendered as "—". A dash reads as "we asked
 * and it has none", which is a different claim from "the dealer did not declare
 * this" — and a vendor prices on the difference.
 *
 * Two rules here are load-bearing:
 *   · warranty_cycles ALWAYS reads "rated". It is design life, not consumed
 *     life; printed bare a vendor reads it as the cycle count they asked for,
 *     which we do not have.
 *   · the IOT brand is rendered from iot_brand_label — the single string that
 *     already carries "(assumed)". A caller given the brand and a flag would
 *     eventually print the brand and drop the caveat.
 */
export function vendorLineMeta(line: VendorLineMetaSource): string[] {
  const nominalV = declared(line.nominal_voltage);
  const nominalAh = declared(line.nominal_ampere);
  const unitKg = declared(line.unit_weight_kg);
  const lineKg = declared(line.line_weight_kg);
  const cycles = declared(line.warranty_cycles);

  const formFactor = line.form_factor
    ? line.form_factor.charAt(0).toUpperCase() + line.form_factor.slice(1).toLowerCase()
    : null;

  // Whichever of volts/amp-hours was declared. Both is the normal case (the
  // submit gate requires the pair), but dropping a declared voltage because its
  // Ah was blank would hide a number the vendor is entitled to.
  const nominal =
    nominalV || nominalAh
      ? `${[nominalV && `${nominalV}V`, nominalAh && `${nominalAh}Ah`]
          .filter(Boolean)
          .join(" ")} nominal`
      : null;

  return [
    line.variant_type,
    line.brand,
    line.chemistry,
    formFactor,
    nominal,
    unitKg && `${unitKg} kg/unit`,
    lineKg && `${lineKg} kg total`,
    cycles && `${cycles} cycles rated`,
    line.condition_split_label,
    line.iot_battery === false ? "Non-IOT" : line.iot_brand_label,
  ].filter((part): part is string => Boolean(part));
}
