import { spendWindowOptions } from "@/lib/operations/spendWindow";

/**
 * The window /operations/spend reconciles over.
 *
 * A plain GET form with no client state, matching ElevenLabsFilterBar for the
 * same reasons: the selected window lives in the URL, so a filtered view is a
 * pasteable link, and <AutoRefresh> calling router.refresh() every 60 seconds
 * re-renders the SAME window instead of snapping back to the default — which is
 * exactly what would happen if the selection lived in client state.
 *
 * One control, one parameter, one form. The burn chart's bars navigate to the
 * same `?window=` parameter, so the two controls cannot disagree or produce a
 * URL with a precedence puzzle in it.
 */
export function SpendWindowSelector({ selected }: { selected: string }) {
  const options = spendWindowOptions();

  return (
    <form
      method="get"
      action="/operations/spend"
      className="flex items-center gap-1"
    >
      <label className="sr-only" htmlFor="spend-window">
        Spend window
      </label>
      <select
        id="spend-window"
        name="window"
        defaultValue={selected}
        className="h-8 rounded-lg border border-border bg-surface px-2 text-xs text-ink focus:border-brand-sky focus:outline-none"
      >
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
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
  );
}
