"use client";

/**
 * TrackHistoryBar — a compact, always-visible timeline strip shared by the
 * Field Investigation and Video KYC panels. Each entry is one event in the
 * track's life (a run, a decision, a re-inspection) with a coloured status dot,
 * a label, an optional detail (agent / reason / reviewer notes), and a relative
 * time. Newest first. Renders nothing when there is no history.
 */

export type HistoryTone = "pass" | "fail" | "info" | "neutral";

export interface HistoryBarEntry {
  key: string;
  label: string;
  tone: HistoryTone;
  detail?: string | null;
  at?: string | null;
}

const DOT: Record<HistoryTone, string> = {
  pass: "bg-emerald-500",
  fail: "bg-red-500",
  info: "bg-amber-500",
  neutral: "bg-slate-300",
};

function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diffMs)) return "";
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function TrackHistoryBar({
  title,
  entries,
}: {
  title: string;
  entries: HistoryBarEntry[];
}) {
  if (entries.length === 0) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-2.5">
      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">
        {title}
      </p>
      <ol className="space-y-1.5">
        {entries.map((e) => (
          <li key={e.key} className="flex items-start gap-2 text-[11px] leading-snug">
            <span className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${DOT[e.tone]}`} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="font-semibold text-slate-700">{e.label}</span>
              {e.detail ? <span className="text-slate-500"> — {e.detail}</span> : null}
            </span>
            {e.at ? <span className="shrink-0 text-slate-400">{relTime(e.at)}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
