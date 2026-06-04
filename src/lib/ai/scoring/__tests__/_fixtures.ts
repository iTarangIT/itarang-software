// Test helpers — build a fully-typed IntentSignals from a terse spec so the
// scoring tests read like a table.

import type {
  IntentSignals,
  SignalLevel,
  TimelineLevel,
  ObjectionLevel,
  AuthorityLevel,
} from "../signals";

export interface SignalSpec {
  need?: SignalLevel;
  budget?: SignalLevel;
  engagement?: SignalLevel;
  curiosity?: SignalLevel;
  timeline?: TimelineLevel;
  objection?: ObjectionLevel;
  authority?: AuthorityLevel;
  quantity?: string | null;
  callback?: boolean;
  competitor?: string | null;
  not_interested?: boolean;
  competitor_bought?: boolean;
  do_not_call?: boolean;
  hostile?: boolean;
  too_short?: boolean;
}

export function mk(p: SignalSpec = {}): IntentSignals {
  const lvl = <T>(level: T) => ({ level, evidence: "test" });
  return {
    need: lvl(p.need ?? "unknown"),
    budget: lvl(p.budget ?? "unknown"),
    engagement: lvl(p.engagement ?? "unknown"),
    curiosity: lvl(p.curiosity ?? "unknown"),
    timeline: lvl(p.timeline ?? "unknown"),
    objection_quality: lvl(p.objection ?? "unknown"),
    authority: lvl(p.authority ?? "unknown"),
    facts: {
      quantity: p.quantity ?? null,
      callback_requested: !!p.callback,
      competitor_named: p.competitor ?? null,
    },
    negatives: {
      explicit_not_interested: !!p.not_interested,
      already_bought_competitor: !!p.competitor_bought,
      do_not_call: !!p.do_not_call,
      hostile: !!p.hostile,
      call_too_short: !!p.too_short,
    },
    language: "hinglish",
    call_summary: "test summary",
    callback_time: null,
  };
}
