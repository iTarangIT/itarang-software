import Link from "next/link";

import {
  USAGE_DAY_WINDOWS,
  type UsageFilters,
} from "@/lib/operations/usageMath";

/**
 * Filters for the login history, as a plain GET form.
 *
 * Same shape and same reasoning as LogFilterBar: no client state, submitting
 * navigates, so every filtered view has a URL you can paste into a thread and
 * the page survives AutoRefresh's router.refresh() without resetting itself.
 *
 * The people list is passed in rather than fetched: it comes from the rows
 * already on screen, so the dropdown can only ever offer somebody who actually
 * appears in the current window. A full staff directory here would turn a
 * filter into a roster.
 */
export function UsageFilterBar({
  filters,
  people,
}: {
  filters: UsageFilters;
  people: { id: string; name: string }[];
}) {
  const inputClass =
    "h-8 rounded-lg border border-border bg-surface px-2 text-xs text-ink focus:border-brand-sky focus:outline-none";

  return (
    <form
      method="get"
      action="/operations/usage"
      className="flex flex-wrap items-end gap-2"
    >
      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
          Window
        </span>
        <select
          name="days"
          defaultValue={String(filters.days)}
          className={inputClass}
        >
          {USAGE_DAY_WINDOWS.map((d) => (
            <option key={d} value={d}>
              {d === 1 ? "24 hours" : `${d} days`}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
          Person
        </span>
        <select
          name="user"
          defaultValue={filters.user ?? ""}
          className={inputClass}
        >
          <option value="">Everyone</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <button
        type="submit"
        className="h-8 rounded-lg bg-brand-navy px-3 text-xs font-semibold text-white transition-colors hover:bg-brand-700"
      >
        Apply
      </button>

      {(filters.user || filters.days !== 7) && (
        <Link
          href="/operations/usage"
          className="h-8 self-end text-xs font-semibold leading-8 text-ink-muted underline-offset-2 hover:text-brand-700 hover:underline"
        >
          Reset
        </Link>
      )}
    </form>
  );
}
