"use client";

/**
 * E-224 — one sorting control for every table on the CEO dashboard.
 *
 * The ordering RULES live in tableSortCore.ts, which has no React in it and is
 * unit-tested. This file is the React skin over them: the state, and the header
 * cell that drives it.
 *
 * Sorting happens on the CLIENT, over rows already in hand, for the same reason
 * paging does (see Pagination.tsx): every list that uses this is server-capped
 * well below the point where a round trip would be worth it.
 *
 * That cap is the one hazard. Sorting a truncated list ascending shows the
 * smallest row OF THE PAGE THE SERVER SENT, not of the window — so a list that
 * can be capped has to say when it was, which is why the drill-down surfaces
 * `capped` rather than leaving a re-sorted 500 rows reading as "everything".
 */

import React from "react";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import {
  makeComparator,
  nextSortState,
  type SortSpec,
  type SortState,
} from "./tableSortCore";

export {
  initialDir,
  isEmpty,
  makeComparator,
  nextSortState,
  sortRows,
} from "./tableSortCore";
export type { SortDir, SortSpec, SortState, SortType } from "./tableSortCore";

/**
 * Hold the sort state for one table and hand back a comparator.
 *
 * The comparator is returned rather than the sorted rows so a caller with
 * structure to preserve can apply it at the right level — the sales drill-down
 * sorts invoice GROUPS with it, not the line items inside them.
 */
export function useTableSort<T>(specs: SortSpec<T>[]) {
  const [sort, setSort] = React.useState<SortState | null>(null);

  const specByKey = React.useMemo(() => {
    const m = new Map<string, SortSpec<T>>();
    for (const s of specs) m.set(s.key, s);
    return m;
  }, [specs]);

  const toggle = React.useCallback(
    (key: string) => {
      const spec = specByKey.get(key);
      if (!spec) return;
      setSort((current) => nextSortState(current, key, spec.type));
    },
    [specByKey],
  );

  const comparator = React.useMemo(() => {
    if (!sort) return null;
    const spec = specByKey.get(sort.key);
    if (!spec) return null;
    return makeComparator(spec, sort.dir);
  }, [sort, specByKey]);

  return { sort, toggle, comparator };
}

interface SortableThProps {
  label: string;
  /** Omit to render a plain, non-sortable header cell. */
  sortKey?: string;
  sort: SortState | null;
  onToggle: (key: string) => void;
  align?: "right";
  className?: string;
  /** Extra explanation on hover — e.g. what a group-level sort actually orders by. */
  title?: string;
}

export function SortableTh({
  label,
  sortKey,
  sort,
  onToggle,
  align,
  className = "",
  title,
}: SortableThProps) {
  const base = `py-2 px-2 font-semibold ${align === "right" ? "text-right" : ""} ${className}`;

  if (!sortKey) {
    return <th className={base}>{label}</th>;
  }

  const active = sort?.key === sortKey;
  const dir = active ? sort.dir : null;

  return (
    <th
      className={base}
      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
    >
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        title={title ?? `Sort by ${label}`}
        className={`inline-flex items-center gap-1 uppercase tracking-wider transition-colors rounded hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200 ${
          align === "right" ? "flex-row-reverse" : ""
        } ${active ? "text-brand-700" : ""}`}
      >
        <span>{label}</span>
        {dir === "asc" ? (
          <ChevronUp className="w-3 h-3 shrink-0" />
        ) : dir === "desc" ? (
          <ChevronDown className="w-3 h-3 shrink-0" />
        ) : (
          // Always occupies the same space as a live arrow, so turning sorting
          // on does not nudge every other header sideways.
          <ChevronsUpDown className="w-3 h-3 shrink-0 text-gray-300" />
        )}
      </button>
    </th>
  );
}
