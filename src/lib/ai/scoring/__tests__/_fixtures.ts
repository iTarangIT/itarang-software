// Test helper — build a fully-typed QualificationSignals from a terse spec so
// the band tests read like a table.

import { EMPTY_SIGNALS, type QualificationSignals, type Disqualifier } from "../signals";

export interface SignalSpec {
  relevant?: boolean; // relevant_dealer — default true
  segment?: QualificationSignals["dealer_segment"];
  role?: QualificationSignals["dealer_role"];
  // the five info signals
  spec?: boolean; // battery_spec_shared
  volume?: boolean; // volume_shared
  financier?: boolean; // existing_financier_shared
  need?: boolean; // financing_need_expressed
  value?: boolean; // financing_value_acknowledged
  // progression
  pitch?: boolean; // pitch_heard — default true
  callback?: boolean; // callback_agreed
  disqualifier?: Disqualifier;
}

const yn = (b: boolean | undefined): "yes" | "no" => (b ? "yes" : "no");

export function mk(p: SignalSpec = {}): QualificationSignals {
  return {
    ...EMPTY_SIGNALS,
    relevant_dealer: yn(p.relevant ?? true),
    dealer_segment: p.segment ?? "battery",
    dealer_role: p.role ?? "dealer",
    battery_spec_shared: yn(p.spec),
    volume_shared: yn(p.volume),
    existing_financier_shared: yn(p.financier),
    financing_need_expressed: yn(p.need),
    financing_value_acknowledged: yn(p.value),
    pitch_heard: yn(p.pitch ?? true),
    callback_agreed: yn(p.callback),
    disqualifier: p.disqualifier ?? "none",
  };
}
