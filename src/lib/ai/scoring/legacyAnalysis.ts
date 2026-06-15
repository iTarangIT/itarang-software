// Back-compat bridges. The band engine produces signals + a yes/no
// score_breakdown + a band, but stored data and some secondary callers still
// expect a coarse `outcome` label and a `memory` blob. These derive those shapes
// from the new signals so storage glue and untouched components keep working.
// The drawer renders the band + breakdown directly; these are the fallback.

import type { QualificationSignals } from "./signals";

export type LegacyOutcome =
  | "interested"
  | "not_interested"
  | "callback_requested"
  | "unknown";

export interface LegacyMemory {
  requirement: string | null;
  product_interest: string | null;
  quantity: string | null;
  intent_summary: string;
  followup_reason: string | null;
}

/** Derive the coarse outcome label from band signals. */
export function deriveOutcome(signals: QualificationSignals): LegacyOutcome {
  const d = signals.disqualifier;
  if (d === "dont_call" || d === "hostile" || d === "not_interested") {
    return "not_interested";
  }
  if (signals.callback_agreed === "yes") return "callback_requested";

  const disclosedSomething =
    signals.battery_spec_shared === "yes" ||
    signals.volume_shared === "yes" ||
    signals.existing_financier_shared === "yes" ||
    signals.financing_need_expressed === "yes" ||
    signals.financing_value_acknowledged === "yes";
  if (disclosedSomething) return "interested";
  return "unknown";
}

/** Build the legacy memory blob (drives intent_reason + summary text). */
export function toLegacyMemory(signals: QualificationSignals): LegacyMemory {
  const orNull = (s: string) => (s && s !== "unknown" ? s : null);
  const ev = signals.evidence;
  return {
    requirement:
      orNull(ev.financing_need_expressed) || orNull(ev.volume_shared) || null,
    product_interest: orNull(ev.battery_spec_shared),
    quantity: orNull(ev.volume_shared),
    intent_summary: signals.call_summary || "",
    followup_reason:
      signals.callback_agreed === "yes"
        ? orNull(ev.callback_agreed) || "callback agreed"
        : null,
  };
}
