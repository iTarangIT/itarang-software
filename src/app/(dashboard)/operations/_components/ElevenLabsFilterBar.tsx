import Link from "next/link";

import {
  RANGE_PRESETS,
  type ElevenLabsFilters,
} from "@/lib/operations/elevenlabsSeries";
import { cn } from "@/lib/utils";

/**
 * The date filter for /operations/elevenlabs.
 *
 * Server-rendered, no client state, same reasoning as LogFilterBar: every
 * filtered view gets a URL you can paste into a thread, and the page works with
 * JavaScript still loading. There is a second reason specific to this page —
 * <AutoRefresh> calls router.refresh() every 60 seconds, which would wipe any
 * client-held filter state. Because the range lives in the URL instead,
 * refreshing re-renders the SAME window rather than snapping back to default.
 *
 * ONE PARAMETER, `range`, carries both controls: a preset key (mtd/3m/6m/all)
 * or a YYYY-MM month. Two controls writing one param inside a single form would
 * submit `?range=3m&range=2026-02`, where the winner depends on DOM order — a
 * precedence rule invisible from the URL. Two SEPARATE params would need a
 * documented precedence rule and would leave a dead param in the URL, so a
 * bookmarked link would silently disagree with what is on screen. With one
 * param and one authoritative control per navigation, "both set at once" is not
 * representable at all.
 *
 * That is why the presets are links (a navigation) and the month selector is a
 * one-control form (a different navigation) rather than both living in one form.
 */
export function ElevenLabsFilterBar({
  filters,
  months,
}: {
  filters: ElevenLabsFilters;
  /** Newest first, from monthOptions(view.first_call_at). */
  months: { value: string; label: string }[];
}) {
  const activeIsMonth = !RANGE_PRESETS.some((p) => p.key === filters.key);

  // A month in the URL that predates the first call passes shape validation but
  // has no option, and a <select> whose value is absent shows the wrong entry.
  const options =
    activeIsMonth && !months.some((m) => m.value === filters.key)
      ? [{ value: filters.key, label: filters.label }, ...months]
      : months;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1">
        {RANGE_PRESETS.map((preset) => {
          const active = filters.key === preset.key;
          return (
            <Link
              key={preset.key}
              href={`/operations/elevenlabs?range=${preset.key}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                active
                  ? "bg-brand-navy text-white"
                  : "text-ink-muted hover:bg-brand-50 hover:text-brand-700",
              )}
            >
              {preset.label}
            </Link>
          );
        })}
      </div>

      <form
        method="get"
        action="/operations/elevenlabs"
        className="flex items-center gap-1"
      >
        <label className="sr-only" htmlFor="elevenlabs-range">
          Jump to a month
        </label>
        <select
          id="elevenlabs-range"
          name="range"
          // The sentinel carries the ACTIVE key, so submitting without choosing
          // is a genuine no-op rather than a silent reset to month-to-date.
          defaultValue={activeIsMonth ? filters.key : filters.key}
          className="h-8 rounded-lg border border-border bg-surface px-2 text-xs text-ink focus:border-brand-sky focus:outline-none"
        >
          {!activeIsMonth && (
            <option value={filters.key}>Jump to a month…</option>
          )}
          {options.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="h-8 rounded-lg bg-brand-navy px-3 text-xs font-semibold text-white transition-colors hover:bg-brand-700"
        >
          Apply
        </button>
      </form>

      {filters.key !== "mtd" && (
        // No query string at all, so the reset URL and the default URL are the
        // same string — a shared link is never "the default, but with ?range=mtd".
        <Link
          href="/operations/elevenlabs"
          className="text-xs font-semibold text-ink-muted underline-offset-2 hover:text-brand-700 hover:underline"
        >
          Reset
        </Link>
      )}

      <span className="ml-auto text-[11px] text-ink-muted">
        Showing <span className="font-semibold text-ink">{filters.label}</span>
      </span>
    </div>
  );
}
