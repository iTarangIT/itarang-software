// Unifies a dealer lead's call history from the two stores that hold it:
//   - ai_call_logs        — the CANONICAL per-call store (campaign drawer, cost
//                           analytics, backfill cron all read this).
//   - follow_up_history   — the legacy JSONB column on dealer_leads.
//
// The /leads/[id] detail page historically read ONLY follow_up_history, so calls
// that landed in ai_call_logs (AI-dialer / no-transcript / webhook paths) were
// invisible. This merges both into one CallItem[] the UI renders, preferring the
// canonical ai_call_logs row and folding in any legacy history entry that has no
// matching log (matched on call timestamp within a 2-minute window).

export interface CallItem {
  key: string;
  index: number; // 1-based, oldest → newest, for display
  source: "log" | "history" | "touchpoint";
  when: string | null; // ISO
  provider: string | null;
  status: string | null; // telephony status (completed / failed / no_answer …)
  outcome: string | null; // legacy follow_up_history outcome label
  band: string | null; // Qualified | Warm | Cold | Disqualified
  call_status: string | null; // complete | dropped_partial | dropped_empty
  info_signals_count: number | null;
  intent_score: number | null;
  duration: number | null; // seconds
  recording_url: string | null;
  transcript: string | null;
  summary: string | null;
  next_call_at: string | null;
  // Who made the call, when it was not us. Only set for `touchpoint` items —
  // an external telecaller (a NeoDove agent) has no users row here, so their
  // name is free text (lead_touchpoints.external_agent_name, E-226).
  external_agent_name?: string | null;
  external_system?: string | null;
}

// Minimal shapes — we only read the fields we map (full rows are passed in).
type AiCallLogRow = {
  id: string;
  provider: string | null;
  status: string | null;
  intent_score: number | null;
  transcript: string | null;
  summary: string | null;
  recording_url: string | null;
  call_duration: number | null;
  band: string | null;
  call_status: string | null;
  info_signals_count: number | null;
  started_at: Date | string | null;
  created_at: Date | string | null;
};

type HistoryEntry = {
  attempt?: number;
  called_at?: string | null;
  outcome?: string | null;
  transcript?: string | null;
  next_call_at?: string | null;
  provider?: string | null;
  band?: string | null;
  call_status?: string | null;
  info_signals_count?: number | null;
  intent_score?: number | null;
  analysis?: { intent_score?: number | string; summary?: string } | null;
};

const toIso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : typeof d === "string" ? d : d.toISOString();

const ts = (iso: string | null): number =>
  iso ? new Date(iso).getTime() : NaN;

const DEDUP_WINDOW_MS = 2 * 60 * 1000;

function fromLog(r: AiCallLogRow): Omit<CallItem, "index"> {
  return {
    key: `log:${r.id}`,
    source: "log",
    when: toIso(r.started_at) ?? toIso(r.created_at),
    provider: r.provider,
    status: r.status,
    outcome: null,
    band: r.band,
    call_status: r.call_status,
    info_signals_count: r.info_signals_count,
    intent_score: r.intent_score,
    duration: r.call_duration,
    recording_url: r.recording_url,
    transcript: r.transcript && r.transcript.trim() ? r.transcript : null,
    summary: r.summary && r.summary.trim() ? r.summary : null,
    next_call_at: null,
  };
}

function fromHistory(h: HistoryEntry, i: number): Omit<CallItem, "index"> {
  const score =
    typeof h.intent_score === "number"
      ? h.intent_score
      : h.analysis?.intent_score != null
        ? Number(h.analysis.intent_score)
        : null;
  return {
    key: `hist:${h.attempt ?? i}:${h.called_at ?? i}`,
    source: "history",
    when: h.called_at ?? null,
    provider: h.provider ?? null,
    status: null,
    outcome: h.outcome ?? null,
    band: h.band ?? null,
    call_status: h.call_status ?? null,
    info_signals_count: h.info_signals_count ?? null,
    intent_score: Number.isFinite(score as number) ? (score as number) : null,
    duration: null,
    recording_url: null,
    transcript: h.transcript && h.transcript.trim() ? h.transcript : null,
    summary: h.analysis?.summary ?? null,
    next_call_at: h.next_call_at ?? null,
  };
}

/**
 * A call made in an EXTERNAL system, recorded as a touchpoint here.
 *
 * NeoDove dispositions arrive on a webhook and are written to lead_touchpoints,
 * never to ai_call_logs — that table is what OUR dialer did, and a NeoDove row
 * parked there would be swept by the dialer cron and counted in AI-vs-human
 * reporting as a robot call. Correct, but it meant every one of these calls was
 * invisible to Call History / Total Calls / Latest Status, which read only
 * ai_call_logs: a lead could show "No calls made yet" directly above an Activity
 * timeline entry describing the call. This is the third source that closes that.
 *
 * No transcript, no intent score and no recording on this path — the fixed
 * NeoDove webhook payload carries none of them (docs/neodove-contract.md §4) —
 * so these items deliberately count towards Total Calls but not Transcripts.
 */
export type ExternalCallTouchpoint = {
  id: string;
  touchpoint_type: string;
  call_status: string | null;
  external_system: string | null;
  external_agent_name?: string | null;
  recording_url?: string | null;
  remarks: string | null;
  created_at: Date | string | null;
};

// Touchpoint types that represent an actual conversation attempt. A
// `neodove_dial_request` is a HAND-OFF, not a call (see
// src/lib/lifecycle/touchpointTypes.ts) and must never be counted here — it
// would inflate Total Calls with requests nobody has acted on yet.
const CALL_TOUCHPOINT_TYPES = new Set(["inside_sales_call", "ai_call"]);

export function isExternalCallTouchpoint(t: {
  touchpoint_type: string;
  external_system: string | null;
}): boolean {
  return Boolean(t.external_system) && CALL_TOUCHPOINT_TYPES.has(t.touchpoint_type);
}

function fromTouchpoint(t: ExternalCallTouchpoint): Omit<CallItem, "index"> {
  return {
    key: `tp:${t.id}`,
    source: "touchpoint",
    when: toIso(t.created_at),
    // The vendor, so the row reads "NeoDove" rather than blank.
    provider: t.external_system,
    status: null,
    // The disposition line is the only outcome text this path has; it is what
    // Latest Status falls back to.
    outcome: t.remarks,
    band: null,
    call_status: t.call_status,
    info_signals_count: null,
    intent_score: null,
    duration: null,
    recording_url: t.recording_url ?? null,
    transcript: null,
    summary: null,
    next_call_at: null,
    external_agent_name: t.external_agent_name ?? null,
    external_system: t.external_system,
  };
}

/**
 * Merge ai_call_logs rows + follow_up_history + external call touchpoints into
 * one chronological list. ai_call_logs wins; a history entry is included only
 * when no log row sits within DEDUP_WINDOW_MS of it (history lacks a stable call
 * id to join on).
 *
 * Touchpoints are NOT deduped against logs: they come from a different system
 * making a different call, so a NeoDove call and an AI call a minute apart are
 * two real calls, not one double-recorded.
 */
export function normalizeCalls(
  logs: AiCallLogRow[],
  history: HistoryEntry[],
  externalCalls: ExternalCallTouchpoint[] = [],
): CallItem[] {
  const logItems = logs.map(fromLog);
  const logTimes = logItems.map((l) => ts(l.when)).filter((n) => !Number.isNaN(n));

  const historyItems = history
    .map(fromHistory)
    .filter((h) => {
      const t = ts(h.when);
      if (Number.isNaN(t)) return true; // no timestamp → keep (can't dedup)
      return !logTimes.some((lt) => Math.abs(lt - t) <= DEDUP_WINDOW_MS);
    });

  const touchpointItems = externalCalls.map(fromTouchpoint);

  const merged = [...logItems, ...historyItems, ...touchpointItems].sort((a, b) => {
    const ta = ts(a.when);
    const tb = ts(b.when);
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return ta - tb; // oldest first → attempt #1 is the first call
  });

  return merged.map((c, i) => ({ ...c, index: i + 1 }));
}
