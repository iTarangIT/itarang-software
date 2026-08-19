// THE single source of truth for intent thresholds and the score→status label.
// The band model carries each band's lead_score (90/60/30/0) in the numeric
// intent_score, so these thresholds keep classifying it identically
// (90 ≥ QUALIFIED → qualified, 60 ≥ WARM → warm, 30 ≥ COLD → cold) — every
// downstream bucket/sort that compares the number stays correct unchanged.

// Aligned set (decided with the team): matches the existing >=75 conversion
// filters already used across SQL/UI.
export const INTENT_THRESHOLDS = {
  QUALIFIED: 75,
  WARM: 45,
  COLD: 20,
} as const;

// Finer VISUAL-ONLY tier for "hot" badges. Never used for routing or status.
export const HOT_BADGE = 85;

export type LeadStatus = "qualified" | "warm" | "cold" | "disqualified";

/**
 * Map a canonical score to a status label. With the band model the score is the
 * band's lead_score, so this is a pure numeric classifier — the band itself is
 * the source of truth and is persisted directly; this remains for bare-score
 * callers (e.g. carrying a prior score forward) and old rows.
 */
export function leadStatusFor(score: number): LeadStatus {
  if (score >= INTENT_THRESHOLDS.QUALIFIED) return "qualified";
  if (score >= INTENT_THRESHOLDS.WARM) return "warm";
  if (score >= INTENT_THRESHOLDS.COLD) return "cold";
  return "disqualified";
}

// Lowercased band → status label, for callers that have a Band string.
export function bandToStatus(band: string | null): LeadStatus | null {
  switch (band) {
    case "Qualified":
      return "qualified";
    case "Warm":
      return "warm";
    case "Cold":
      return "cold";
    case "Disqualified":
      return "disqualified";
    default:
      return null;
  }
}

// Status label → canonical Band. The exact inverse of bandToStatus, and the
// bridge the HUMAN OVERRIDE crosses: the correction UI speaks lowercase status
// labels (the four buttons a reviewer clicks), while every persisted column and
// every downstream reader speaks Band. Without this the override would have to
// hand-roll the mapping and could silently drift from the AI path.
export function statusToBand(
  status: string | null,
): "Qualified" | "Warm" | "Cold" | "Disqualified" | null {
  switch ((status ?? "").toLowerCase()) {
    case "qualified":
      return "Qualified";
    case "warm":
      return "Warm";
    case "cold":
      return "Cold";
    case "disqualified":
      return "Disqualified";
    default:
      return null;
  }
}
