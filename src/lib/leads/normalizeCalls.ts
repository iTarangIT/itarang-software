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
  source: "log" | "history";
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
 * Merge ai_call_logs rows + follow_up_history into one chronological list.
 * ai_call_logs wins; a history entry is included only when no log row sits
 * within DEDUP_WINDOW_MS of it (history lacks a stable call id to join on).
 */
export function normalizeCalls(
  logs: AiCallLogRow[],
  history: HistoryEntry[],
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

  const merged = [...logItems, ...historyItems].sort((a, b) => {
    const ta = ts(a.when);
    const tb = ts(b.when);
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return ta - tb; // oldest first → attempt #1 is the first call
  });

  return merged.map((c, i) => ({ ...c, index: i + 1 }));
}
