/**
 * Shared shapes for the CEO Expense Ledger card.
 *
 * The panel, its two table views and its filter row all speak these; they live
 * here rather than in the panel so importing a table does not drag the
 * container's fetch logic in with it.
 */

/** One invoice, exactly as /api/dashboard/ceo/expense-ledger returns it. */
export interface LedgerRow {
  id: string;
  vendor: string | null;
  amount: string;
  description: string | null;
  department: string | null;
  bucket: string | null;
  project_tag: string | null;
  expense_date: string | null;
  bill_url: string | null;
  created_at: string;
  submitter_name: string | null;
}

/**
 * One department's line in the summary view.
 *
 * `count` and `total` come from a SQL GROUP BY over the whole window, NOT from
 * the `rows` array — which is capped. A department can therefore legitimately
 * report a count larger than the number of its rows on hand, and the UI says so
 * rather than quietly showing the smaller number.
 */
export interface DepartmentSummary {
  /** Department value, or "unassigned" for a NULL department. */
  key: string;
  label: string;
  count: number;
  total: number;
}

export interface LedgerResponse {
  period: string;
  label: string;
  departments: DepartmentSummary[];
  grandTotal: number;
  grandCount: number;
  rows: LedgerRow[];
  vendors: string[];
  projects: string[];
  capped: boolean;
  cap: number;
}

/**
 * The filter set, shared by both views so it survives the Summary/Detail
 * toggle by construction rather than by being copied between them.
 *
 * "all" rather than null for the empty case, because these drive <select>
 * values and a select whose value is null is an uncontrolled select.
 */
export interface LedgerFilterState {
  department: string;
  bucket: string;
  project: string;
  vendor: string;
  /** Free text, matched across every field the table shows. "" is off. */
  search: string;
  /**
   * The ledger's own date range, YYYY-MM-DD, `to` inclusive. "" is off.
   *
   * When either end is set it REPLACES the dashboard window rather than
   * narrowing it — the same thing the expenses drill-down and the bucket panel
   * do with their date fields. Two ranges that intersect would leave the card
   * showing a span that matches neither the bar above it nor the boxes inside
   * it; one of them has to win, and it should be the one the reader just typed.
   */
  from: string;
  to: string;
}

export const EMPTY_LEDGER_FILTERS: LedgerFilterState = {
  department: "all",
  bucket: "all",
  project: "all",
  vendor: "all",
  search: "",
  from: "",
  to: "",
};

/** True when the ledger's own date range is overriding the dashboard window. */
export function hasDateOverride(f: LedgerFilterState): boolean {
  return Boolean(f.from || f.to);
}

/** Everything that narrows the ledger, including its date override. */
export function hasActiveLedgerFilter(f: LedgerFilterState): boolean {
  return (
    f.department !== "all" ||
    f.bucket !== "all" ||
    f.project !== "all" ||
    f.vendor !== "all" ||
    f.search.trim() !== "" ||
    hasDateOverride(f)
  );
}

/** The filters as query params, omitting the "all"/empty defaults. */
export function ledgerFilterParams(f: LedgerFilterState): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.department !== "all") sp.set("department", f.department);
  if (f.bucket !== "all") sp.set("bucket", f.bucket);
  if (f.project !== "all") sp.set("project", f.project);
  if (f.vendor !== "all") sp.set("vendor", f.vendor);
  const q = f.search.trim();
  if (q) sp.set("q", q);
  return sp;
}

/**
 * The window the ledger should ask for: its own range when one is set,
 * otherwise whatever the dashboard bar selected.
 *
 * `period=range` is what resolveWindowParams expects alongside from/to, and a
 * range with only one end filled is legal — the resolver treats the missing end
 * as open.
 */
export function ledgerWindowParams(
  pageParams: string | undefined,
  f: LedgerFilterState,
): URLSearchParams {
  if (!hasDateOverride(f)) return new URLSearchParams(pageParams ?? "");
  const sp = new URLSearchParams({ period: "range" });
  if (f.from) sp.set("from", f.from);
  if (f.to) sp.set("to", f.to);
  return sp;
}

/**
 * The gutter between columns, applied to every cell of thead, tbody and tfoot
 * alike.
 *
 * Stated once and shared because the bug it fixes came from them disagreeing:
 * headers carried `!px-0` and body cells carried no horizontal padding at all,
 * so adjacent columns touched — "Miscellaneous" ran into "Office Rental" and the
 * amount ran into "View", which reads as broken rather than dense.
 *
 * `first:pl-0 last:pr-0` keeps the outer edges flush with the card's own
 * padding; an indented first column leaves the table looking inset from the
 * heading above it.
 */
export const CELL = "px-3 first:pl-0 last:pr-0";

/**
 * The same gutter for header cells, marked important.
 *
 * SortableTh applies its own `px-2`, and two conflicting padding utilities
 * resolve by stylesheet order rather than by which was passed last — so the
 * header would sometimes take the component's value and drift out of alignment
 * with the body beneath it.
 */
export const HEAD_CELL = "!px-3 first:!pl-0 last:!pr-0";
