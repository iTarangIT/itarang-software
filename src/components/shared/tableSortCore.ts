/**
 * E-224 — the ordering rules behind TableSort.tsx, with no React in them.
 *
 * Split out from the component because this is where the decisions live —
 * where an empty cell goes, which way a column opens, what the third click
 * does — and vitest here is scoped to pure, no-I/O units (see vitest.config.ts).
 * A rule nobody can test is a rule that quietly stops being true.
 */

export type SortType = "text" | "number" | "date";
export type SortDir = "asc" | "desc";

export interface SortState {
  key: string;
  dir: SortDir;
}

export interface SortSpec<T> {
  key: string;
  type: SortType;
  /** Value to compare. Defaults to `row[key]`. */
  value?: (row: T) => unknown;
}

/**
 * Which way a column opens on its first click.
 *
 * Text opens A→Z; numbers and dates open largest / newest first, because that
 * is the question those columns are usually being asked ("what was the biggest
 * invoice", not "what was the smallest").
 */
export function initialDir(type: SortType): SortDir {
  return type === "text" ? "asc" : "desc";
}

/**
 * The click cycle: sort → reverse → back to the server's own order.
 *
 * Three states rather than two because the order the server chose (effective
 * date descending, for most of these lists) is a meaningful default, and once
 * sorted there would otherwise be no way back to it short of reopening.
 */
export function nextSortState(
  current: SortState | null,
  key: string,
  type: SortType,
): SortState | null {
  const opening = initialDir(type);
  if (!current || current.key !== key) return { key, dir: opening };
  if (current.dir === opening) {
    return { key, dir: opening === "asc" ? "desc" : "asc" };
  }
  return null;
}

/**
 * Nothing to compare: null, undefined, or a blank string. NOT zero and NOT
 * `false` — a ₹0 line is a value, an absent amount is not.
 */
export function isEmpty(v: unknown): boolean {
  return v == null || (typeof v === "string" && v.trim() === "");
}

/**
 * Reduce a raw cell to something comparable, or `null` when there is nothing to
 * compare it by.
 *
 * A value that will not PARSE — "not a date", an amount of "N/A" — is folded
 * into the same null as a missing one. Both mean "this row does not have this
 * quantity", and the alternative is comparing NaN, which is false against
 * everything and scrambles the rows around it.
 *
 * Doing it here, before direction is applied, is the whole point: an earlier
 * version handled NaN inside the comparison and let the `desc` flip negate the
 * answer, so unparseable rows sank when ascending and floated to the TOP when
 * descending. A unit test caught it.
 */
function comparable(v: unknown, type: SortType): number | string | null {
  if (isEmpty(v)) return null;
  if (type === "number") {
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }
  if (type === "date") {
    const t = new Date(v as string).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return String(v);
}

/** Comparator for one column in one direction. */
export function makeComparator<T>(
  spec: SortSpec<T>,
  dir: SortDir,
): (a: T, b: T) => number {
  const read = spec.value ?? ((row: T) => (row as Record<string, unknown>)[spec.key]);
  return (ra, rb) => {
    const a = comparable(read(ra), spec.type);
    const b = comparable(read(rb), spec.type);
    // Unknowns sink in BOTH directions, so this is decided before `dir` is
    // applied. A row with no invoice date is not the earliest one — it is
    // unknown, and heading an ascending list with it reads as data, not a gap.
    if (a === null || b === null) return a === null ? (b === null ? 0 : 1) : -1;
    const base =
      typeof a === "number" && typeof b === "number"
        ? a === b
          ? 0
          : a < b
            ? -1
            : 1
        : String(a).localeCompare(String(b), "en-IN", {
            sensitivity: "base",
            numeric: true, // "Invoice 2" before "Invoice 10"
          });
    return dir === "asc" ? base : -base;
  };
}

/**
 * Apply a comparator without mutating the input. A null comparator returns the
 * original array by reference, so "unsorted" costs nothing and keeps whatever
 * memoisation the caller has around the rows.
 *
 * Array.prototype.sort is stable, so ties keep the server's ordering — the
 * secondary sort is always the one the API applied.
 */
export function sortRows<T>(rows: T[], comparator: ((a: T, b: T) => number) | null): T[] {
  if (!comparator) return rows;
  return [...rows].sort(comparator);
}
