"use client";

/**
 * E-247 — the SLA row inside a verification card.
 *
 * ALWAYS RENDERS ONCE THE CASE IS IN THE ADMIN QUEUE, even when no automation
 * clock is running. The first cut only drew the countdown, so a case whose
 * `sla_due_at` was never stamped showed five cards with nothing on them — which
 * is indistinguishable from the feature being broken, and is exactly how this
 * looked on screen. A row that says "SLA 1h 12m · manual decision required" is
 * the honest version of that state.
 *
 * The card clock is NOT the consent clock. Consent runs on its own per-record
 * deadline (`consent_records.auto_verify_due_at`); a verification card runs on
 * the CASE deadline (`admin_verification_queue.sla_due_at`, stamped at dealer
 * submit), and when it passes the sweep accepts every card still carrying no
 * admin verdict. So all five cards on a case count down to the same instant —
 * that is the automation's actual shape, not a shortcut.
 *
 * DELIBERATELY ONE ROW. This sits between a card header and its body, five
 * times on screen; anything taller pushes the fields an admin actually works
 * with below the fold. Label, countdown and bar share a single ~22px line.
 *
 * `now` is passed in rather than read here so every card and the case header
 * tick off one clock, and so this stays a pure render.
 */

/** "1h 12m" / "3d 4h" / "45m 09s" — same shape as the case-header countdown. */
function formatSpan(ms: number, withSeconds: boolean): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (!withSeconds) return `${minutes}m`;
  // Under an hour the seconds have to move, or a short test window looks like a
  // frozen number for sixty seconds at a time.
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

const BOLT = (
  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
);
const CLOCK = (
  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
);

export default function AutoAcceptTimeline({
  dueAt,
  startAt,
  now,
  settled,
  automationEnabled,
}: {
  /** Case SLA deadline. Null means this case will never auto-approve. */
  dueAt: string | null | undefined;
  /** Dealer submission — the start of the bar, and of the elapsed count. */
  startAt?: string | null;
  /** The parent's one-second tick. */
  now: number;
  /** True once an admin has accepted/rejected this card — their verdict stands
   *  and the sweep will not touch it, so the clock is no longer this card's. */
  settled?: boolean;
  /** Whether card auto-approval is switched on at all. Only changes the wording
   *  of the no-clock row: "off" vs "on, but this case was never admitted". */
  automationEnabled?: boolean;
}) {
  const startMs = startAt ? new Date(startAt).getTime() : NaN;
  const dueMs = dueAt ? new Date(dueAt).getTime() : NaN;
  const hasStart = Number.isFinite(startMs);
  const hasDue = Number.isFinite(dueMs);

  // Nothing to report: the case is not in the admin queue yet, or an admin has
  // already ruled on this card and owns it.
  if (settled || (!hasStart && !hasDue)) return null;

  // ---- No clock. Report the SLA that IS running — how long this case has been
  // waiting on a human — and say plainly that nothing will act on it.
  if (!hasDue) {
    const elapsed = formatSpan(Math.max(0, now - startMs), false);
    return (
      <div
        className="flex items-center gap-2 px-5 py-1.5 border-b border-gray-100 bg-gray-50"
        title={
          automationEnabled
            ? "Auto-approval is on, but no deadline was stamped for this case (it reached the queue before the feature was switched on), so it will wait for an admin."
            : "KYC auto-approval is switched off. This card waits for an admin decision."
        }
      >
        <svg className="w-2.5 h-2.5 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {CLOCK}
        </svg>
        <span className="text-[10px] font-medium text-gray-500 whitespace-nowrap tabular-nums">
          SLA <span className="font-semibold">{elapsed}</span>
        </span>
        <span className="text-[10px] text-gray-400 truncate">
          {automationEnabled ? "not on the auto-approval clock" : "auto-approval off"} · manual decision required
        </span>
      </div>
    );
  }

  const spanMs = hasStart ? dueMs - startMs : NaN;
  const pct =
    !Number.isFinite(spanMs) || spanMs <= 0
      ? 100
      : Math.min(100, Math.max(0, ((now - startMs) / spanMs) * 100));

  const remainingMs = dueMs - now;
  const overdue = remainingMs <= 0;
  const left = overdue ? "any moment now" : formatSpan(remainingMs, true);

  return (
    <div
      className="flex items-center gap-2 px-5 py-1.5 border-b border-violet-100 bg-violet-50/60"
      title="If no admin accepts or rejects this card before the case SLA closes, the system accepts it — without calling the verification provider."
    >
      <svg className="w-2.5 h-2.5 flex-shrink-0 text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        {BOLT}
      </svg>
      <span className="text-[10px] font-medium text-violet-700 whitespace-nowrap tabular-nums">
        {overdue ? "Auto-accepting" : "Auto-accepts in"} <span className="font-semibold">{left}</span>
      </span>
      {/* The bar takes the leftover width instead of its own row. No CSS
          transition: the parent re-renders this every second, and a 1s ease on
          top of a 1s tick leaves the fill trailing the number beside it. */}
      <div className="flex-1 h-1 rounded-full bg-violet-100 overflow-hidden">
        <div
          className={`h-full rounded-full bg-violet-400 ${overdue ? "animate-pulse" : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
