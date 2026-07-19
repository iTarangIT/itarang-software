/**
 * The submit gate (BRD M02/M03/M04).
 *
 * "Submit requires ≥1 line, ≥5 photos/line, provenance complete."
 *
 * The prototype only *warned* — it rendered "⚠ Minimum 5 required" and then let
 * the dealer submit anyway, which is how incomplete requests reach the review
 * queue. This is the real gate, and it runs server-side inside the submit
 * transaction.
 *
 * E-191 added the dealer-declared battery spec, with a REQUIRED subset (brand,
 * chemistry, nominal voltage/ampere, unit weight, IOT yes/no — plus the IOT
 * brand name when IOT is yes). Those are enforced HERE, not by NOT NULL: the
 * intake autosaves a line the moment a SKU is picked, long before the spec is
 * typed, so the columns must accept null while the gate refuses to submit them
 * that way.
 *
 * It is a pure function over already-fetched rows so the SAME logic can answer
 * "why is my Submit button disabled?" on the intake page. One implementation,
 * so the button and the server can never disagree.
 */

export const MIN_PHOTOS_PER_LINE = 5;

export interface GateLine {
  id: string;
  /** For the message: "60V 120Ah · Working ×3". */
  label: string;
  quantity: number;
  photo_count: number;
  /** True when the line (or every one of its units) has a provenance record. */
  has_provenance: boolean;
  // --- E-191 dealer-declared spec (null = not provided yet) -----------------
  brand: string | null;
  chemistry: string | null;
  nominal_voltage: number | string | null;
  nominal_ampere: number | string | null;
  unit_weight_kg: number | string | null;
  iot_battery: boolean | null;
  iot_brand_name: string | null;
  functional_qty: number | null;
  non_functional_qty: number | null;
}

export interface GateIssue {
  line_id: string | null;
  code:
    | "NO_LINES"
    | "TOO_FEW_PHOTOS"
    | "MISSING_PROVENANCE"
    | "MISSING_SPECS"
    | "QTY_SPLIT_MISMATCH";
  message: string;
}

export interface GateResult {
  ok: boolean;
  issues: GateIssue[];
}

/** Null, undefined or a whitespace-only string all count as "not provided". */
function blank(v: string | number | boolean | null | undefined): boolean {
  if (v === null || v === undefined) return true;
  return typeof v === "string" && v.trim() === "";
}

/**
 * The E-191 required fields a line is still missing, as human labels for the
 * gate message. Exported so the intake form can mark the same set with "*".
 */
export function missingSpecFields(line: GateLine): string[] {
  const missing: string[] = [];
  if (blank(line.brand)) missing.push("brand");
  if (blank(line.chemistry)) missing.push("chemistry (NMC/LFP)");
  if (blank(line.nominal_voltage)) missing.push("nominal voltage");
  if (blank(line.nominal_ampere)) missing.push("nominal ampere (Ah)");
  if (blank(line.unit_weight_kg)) missing.push("unit weight (kg)");
  if (line.iot_battery === null || line.iot_battery === undefined) {
    missing.push("IOT battery (yes/no)");
  }
  // The IOT brand name is deliberately NOT required. A dealer buying a pack
  // second-hand often cannot know who made the IOT module, and demanding it
  // only bought us guesses. Blank now resolves to DEFAULT_IOT_BRAND at write
  // time (see line-spec.ts) rather than blocking the submit.
  return missing;
}

export function checkSubmitReadiness(lines: GateLine[]): GateResult {
  const issues: GateIssue[] = [];

  if (lines.length === 0) {
    issues.push({
      line_id: null,
      code: "NO_LINES",
      message: "Add at least one battery line before submitting.",
    });
    return { ok: false, issues };
  }

  for (const line of lines) {
    if (line.photo_count < MIN_PHOTOS_PER_LINE) {
      issues.push({
        line_id: line.id,
        code: "TOO_FEW_PHOTOS",
        message: `${line.label} has ${line.photo_count} of ${MIN_PHOTOS_PER_LINE} required photos.`,
      });
    }

    if (!line.has_provenance) {
      issues.push({
        line_id: line.id,
        code: "MISSING_PROVENANCE",
        message: `${line.label} is missing provenance — add the previous owner's details, or mark it as your own stock.`,
      });
    }

    const missing = missingSpecFields(line);
    if (missing.length > 0) {
      issues.push({
        line_id: line.id,
        code: "MISSING_SPECS",
        message: `${line.label} is missing required battery details: ${missing.join(", ")}.`,
      });
    }

    // The functional / non-functional split is optional — but if the dealer
    // declares it, it cannot exceed what is in the lot. A line claiming 5
    // functional out of 3, or 2 + 2 out of 3, is a data bug the review queue
    // should never receive.
    //
    // It must NOT EXCEED the quantity, not EQUAL it. This demanded equality
    // until E-194, which rejected the ordinary case of a dealer who tested
    // some of the lot and not the rest: 5 working + 3 dead out of 10 is a
    // truthful declaration with 2 untested, and the gate called it a data bug.
    // The remainder is simply unclassified.
    const f = line.functional_qty;
    const nf = line.non_functional_qty;
    if (f !== null && nf !== null && f !== undefined && nf !== undefined) {
      if (f + nf > line.quantity) {
        issues.push({
          line_id: line.id,
          code: "QTY_SPLIT_MISMATCH",
          message: `${line.label}: functional (${f}) + non-functional (${nf}) cannot exceed the quantity (${line.quantity}).`,
        });
      }
    } else if ((f ?? nf) !== null && (f ?? nf) !== undefined && (f ?? nf)! > line.quantity) {
      issues.push({
        line_id: line.id,
        code: "QTY_SPLIT_MISMATCH",
        message: `${line.label}: the declared split (${f ?? nf}) cannot exceed the quantity (${line.quantity}).`,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}
