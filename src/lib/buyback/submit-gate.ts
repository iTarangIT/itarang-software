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
}

export interface GateIssue {
  line_id: string | null;
  code: "NO_LINES" | "TOO_FEW_PHOTOS" | "MISSING_PROVENANCE";
  message: string;
}

export interface GateResult {
  ok: boolean;
  issues: GateIssue[];
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
  }

  return { ok: issues.length === 0, issues };
}
