"use client";

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, FileText } from "lucide-react";
import { Modal } from "@/components/leads/lead-v2-modals";
import { formatINRCompact, formatINRExact } from "@/lib/format";
import { expenseBucketLabel, expenseDepartmentLabel } from "@/lib/expenses";
import { Pagination, usePagination } from "@/components/shared/Pagination";
import {
  SortableTh,
  sortRows,
  useTableSort,
  type SortSpec,
  type SortType,
} from "@/components/shared/TableSort";
import {
  EMPTY_EXPENSE_FILTERS,
  ExpenseBucketPanel,
  type ExpenseFilters,
} from "./ExpenseBucketPanel";

export type DrillMetric =
  | "purchases"
  | "sales"
  | "expenses"
  | "inventory"
  | "outstanding";

interface DrillDownModalProps {
  metric: DrillMetric;
  title: string;
  /** Query string for the window, e.g. "period=mtd" or "month=2026-06". */
  params?: string;
  onClose: () => void;
}

type Row = Record<string, unknown>;

type Col = {
  key: string;
  label: string;
  align?: "right";
  render?: (row: Row) => React.ReactNode;
  /**
   * E-224 — makes the header clickable. Omitted where a column has no ordering
   * anyone would ask for (a "View bill" link) or, on the grouped sales list,
   * where the value is per-line and has no meaningful group-level aggregate.
   */
  sort?: SortType;
  /** What to compare, when it is not the raw `row[key]` — a label, a derivation. */
  sortValue?: (row: Row) => unknown;
  /** Extra hover text on the header, for a sort that is not literally the column. */
  sortHint?: string;
};

const money = (v: unknown) => formatINRCompact(Number(v || 0));
const dateIN = (v: unknown) =>
  v ? new Date(v as string).toLocaleDateString("en-IN") : "—";
const txt = (v: unknown) => (v == null || v === "" ? "—" : String(v));

// Whole days a due date is past today (0 if not yet due / no due date).
const overdueDays = (v: unknown): number => {
  if (!v) return 0;
  const due = new Date(v as string);
  if (Number.isNaN(due.getTime())) return 0;
  const today = new Date();
  const days = Math.floor(
    (today.setHours(0, 0, 0, 0) - due.setHours(0, 0, 0, 0)) / 86400000,
  );
  return days > 0 ? days : 0;
};

const COLUMNS: Record<DrillMetric, Col[]> = {
  purchases: [
    { key: "oem_invoice_number", label: "OEM Inv #", sort: "text", render: (r) => txt(r.oem_invoice_number) },
    { key: "oem_name", label: "OEM", sort: "text", render: (r) => txt(r.oem_name) },
    { key: "serial_number", label: "Serial", sort: "text", render: (r) => txt(r.serial_number) },
    { key: "model_type", label: "Model", sort: "text", render: (r) => txt(r.model_type) },
    { key: "oem_invoice_date", label: "Date", sort: "date", render: (r) => dateIN(r.oem_invoice_date) },
    { key: "status", label: "Status", sort: "text", render: (r) => txt(r.status) },
    {
      key: "final_amount",
      label: "Amount",
      align: "right",
      sort: "number",
      render: (r) => money(r.final_amount),
    },
  ],
  sales: [
    // Invoice-level fields render only on the first row of each invoice group so
    // multi-product invoices read as grouped rows, not duplicated headers.
    //
    // E-224 — sorting therefore reorders GROUPS, never the lines inside one (see
    // sortSalesGroups). Which is also why `product_name` carries no sort: it is
    // a per-line value with no group-level aggregate that would mean anything.
    { key: "invoice_number", label: "Invoice #", sort: "text", render: (r) => (r._first ? txt(r.invoice_number) : "") },
    { key: "customer_name", label: "Customer", sort: "text", render: (r) => (r._first ? txt(r.customer_name) : "") },
    { key: "invoice_date", label: "Date", sort: "date", render: (r) => (r._first ? dateIN(r.invoice_date) : "") },
    { key: "product_name", label: "Product", render: (r) => txt(r.product_name) },
    {
      key: "quantity",
      label: "Qty",
      align: "right",
      sort: "number",
      // Quantity is per line, so at group level the only honest ordering is the
      // invoice's total — stamped on the first row of each group by grouping.
      sortValue: (r) => r._groupQty,
      sortHint: "Sort by total quantity on the invoice",
      render: (r) => txt(r.quantity),
    },
    { key: "status", label: "Status", sort: "text", render: (r) => (r._first ? txt(r.status) : "") },
    { key: "total", label: "Total", align: "right", sort: "number", render: (r) => (r._first ? money(r.total) : "") },
    {
      key: "invoice",
      label: "Invoice",
      render: (r) => {
        // E-280 — `document_url` already resolves per source: the Zoho PDF
        // passthrough for a synced invoice, the stored copy of the original for
        // one read out of Drive. The zoho_invoice_id path is kept only as a
        // fallback for a row served before that field existed.
        const href =
          (r.document_url as string | null) ||
          (r.zoho_invoice_id ? `/api/admin/zoho/invoices/${r.zoho_invoice_id}/pdf` : null);
        if (!href || !r._first) return "—";
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-brand-700 font-semibold hover:underline"
          >
            <FileText className="w-3.5 h-3.5" /> View
          </a>
        );
      },
    },
  ],
  expenses: [
    { key: "invoice_number", label: "Invoice #", sort: "text", render: (r) => txt(r.invoice_number) },
    { key: "vendor", label: "Vendor", sort: "text", render: (r) => txt(r.vendor) },
    {
      key: "department",
      label: "Dept",
      // Sorted by the LABEL, not the stored key — "Operations" is what is on
      // screen, and ordering by `ops` would put it under O either way but puts
      // Admin after Finance. Sort what the reader can see.
      sort: "text",
      sortValue: (r) => expenseDepartmentLabel(r.department as string),
      render: (r) => expenseDepartmentLabel(r.department as string),
    },
    {
      key: "bucket",
      label: "Bucket",
      sort: "text",
      sortValue: (r) => expenseBucketLabel(r.bucket as string),
      render: (r) => expenseBucketLabel(r.bucket as string),
    },
    { key: "project_tag", label: "Project", sort: "text", render: (r) => txt(r.project_tag) },
    { key: "created_at", label: "Date Added", sort: "date", render: (r) => dateIN(r.created_at) },
    { key: "expense_date", label: "Invoice Date", sort: "date", render: (r) => dateIN(r.expense_date) },
    { key: "amount", label: "Amount", align: "right", sort: "number", render: (r) => money(r.amount) },
    {
      key: "bill",
      label: "Bill",
      render: (r) => {
        const url = r.bill_url;
        if (!url) return "—";
        return (
          <a
            href={String(url)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-brand-700 font-semibold hover:underline"
          >
            <FileText className="w-3.5 h-3.5" /> View
          </a>
        );
      },
    },
  ],
  inventory: [
    { key: "serial_number", label: "Serial", sort: "text", render: (r) => txt(r.serial_number) },
    { key: "model_type", label: "Model", sort: "text", render: (r) => txt(r.model_type) },
    { key: "oem_name", label: "OEM", sort: "text", render: (r) => txt(r.oem_name) },
    { key: "status", label: "Status", sort: "text", render: (r) => txt(r.status) },
    {
      key: "final_amount",
      label: "Value",
      align: "right",
      sort: "number",
      render: (r) => money(r.final_amount),
    },
  ],
  outstanding: [
    { key: "invoice_number", label: "Invoice #", sort: "text", render: (r) => txt(r.invoice_number) },
    { key: "customer_name", label: "Customer", sort: "text", render: (r) => txt(r.customer_name) },
    { key: "invoice_date", label: "Date", sort: "date", render: (r) => dateIN(r.invoice_date) },
    { key: "due_date", label: "Due", sort: "date", render: (r) => dateIN(r.due_date) },
    { key: "total", label: "Total", align: "right", sort: "number", render: (r) => money(r.total) },
    { key: "balance", label: "Balance", align: "right", sort: "number", render: (r) => money(r.balance) },
    {
      key: "overdue",
      label: "Overdue",
      align: "right",
      // The column is derived, so it has no stored value to order by — sort the
      // same derivation the cell renders.
      sort: "number",
      sortValue: (r) => overdueDays(r.due_date),
      render: (r) => {
        const d = overdueDays(r.due_date);
        return d > 0 ? (
          <span className="font-semibold text-rose-600">{d}d</span>
        ) : (
          "—"
        );
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// E-224 — sales is the one grouped list, so it sorts differently
// ---------------------------------------------------------------------------

/**
 * Split the flat sales rows back into their invoice groups.
 *
 * Grouped on `_first` rather than on `invoice_number`, because that flag is
 * exactly what the server used to mark a group's start — reconstructing the
 * boundaries from a field instead would disagree with it the moment two
 * invoices share a number (a Zoho invoice and an offline sale can).
 */
function salesGroups(rows: Row[]): Row[][] {
  const groups: Row[][] = [];
  for (const row of rows) {
    // A leading row that is not marked `_first` cannot start a group but must
    // not be dropped either, so it joins whatever precedes it.
    if (row._first || groups.length === 0) groups.push([row]);
    else groups[groups.length - 1].push(row);
  }
  return groups;
}

/**
 * Stamp each row with its invoice's total quantity.
 *
 * Qty is a per-line value, so ordering invoices by "the first line's qty" would
 * be arbitrary. The total is the only group-level number the column can honestly
 * be sorted by, and the header says so.
 */
function withGroupTotals(rows: Row[]): Row[] {
  return salesGroups(rows).flatMap((group) => {
    const qty = group.reduce((sum, r) => sum + Number(r.quantity || 0), 0);
    return group.map((r) => ({ ...r, _groupQty: qty }));
  });
}

/**
 * Reorder whole invoices, never the lines inside one.
 *
 * Sorting the flat rows would scatter an invoice's products down the table and
 * blank out its header cells, since those only render on the `_first` row. The
 * group's first row carries every invoice-level field, so it is what the
 * comparator sees; internal order is untouched, which is why `_first` stays
 * correct without being recomputed.
 */
function sortSalesGroups(rows: Row[], comparator: ((a: Row, b: Row) => number) | null): Row[] {
  if (!comparator) return rows;
  return salesGroups(rows)
    .sort((ga, gb) => comparator(ga[0], gb[0]))
    .flat();
}

export function DrillDownModal({ metric, title, params, onClose }: DrillDownModalProps) {
  // E-219 — the expenses drill-down's own filters. Held here rather than inside
  // the panel because they narrow BOTH the breakdown above and the list below,
  // and the two must never be describing different sets of rows.
  //
  // Every one of them is applied server-side. The list stops at ROW_CAP (500),
  // so filtering the fetched rows on the client would show a subset of a
  // department while the count beside the dropdown stated the true one.
  const [filters, setFilters] = React.useState<ExpenseFilters>(EMPTY_EXPENSE_FILTERS);

  // A month or a range picked in the panel REPLACES the window inherited from
  // the page's filter bar. Both are the same kind of statement — which days
  // this is about — so the more specific one wins outright rather than
  // intersecting, which would silently return nothing whenever they disagree.
  const windowParams = React.useMemo(() => {
    if (filters.month) return `month=${filters.month}`;
    if (filters.from || filters.to) {
      const sp = new URLSearchParams({ period: "range" });
      if (filters.from) sp.set("from", filters.from);
      if (filters.to) sp.set("to", filters.to);
      return sp.toString();
    }
    return params ?? "";
  }, [filters.month, filters.from, filters.to, params]);

  const rowParams = [
    windowParams,
    filters.bucket && `bucket=${encodeURIComponent(filters.bucket)}`,
    filters.department && `department=${encodeURIComponent(filters.department)}`,
  ]
    .filter(Boolean)
    .join("&");
  const qs = rowParams ? `?${rowParams}` : "";

  const { data, isLoading, error } = useQuery({
    queryKey: ["ceo-drill-down", metric, rowParams],
    queryFn: async () => {
      const r = await fetch(`/api/dashboard/ceo/drill-down/${metric}${qs}`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error("Failed to load details");
      const j = await r.json();
      return j.data as {
        metric: string;
        total: number;
        rows: Row[];
        /** True when the server's ROW_CAP truncated the list — see the note below. */
        capped?: boolean;
        cap?: number;
      };
    },
  });

  const cols = COLUMNS[metric];

  // E-224 — sortable columns, derived from the column definitions so a new
  // column cannot be sortable in the header and inert in the comparator.
  const sortSpecs = React.useMemo<SortSpec<Row>[]>(
    () =>
      cols
        .filter((c): c is Col & { sort: SortType } => Boolean(c.sort))
        .map((c) => ({ key: c.key, type: c.sort, value: c.sortValue })),
    [cols],
  );
  const { sort, toggle, comparator } = useTableSort<Row>(sortSpecs);

  const rows = React.useMemo(() => {
    const raw = data?.rows ?? [];
    // Stamped up front rather than inside the sort, so the value exists before
    // anyone clicks Qty and does not have to be recomputed on every click.
    return metric === "sales" ? withGroupTotals(raw) : raw;
  }, [data, metric]);

  const sorted = React.useMemo(
    () =>
      metric === "sales"
        ? sortSalesGroups(rows, comparator)
        : sortRows(rows, comparator),
    [rows, comparator, metric],
  );

  const paged = usePagination(sorted);

  // Reset to page one whenever the filters or the sort change. Landing on page
  // 4 of a freshly-filtered two-page list reads as an empty result, and holding
  // page 4 across a re-sort shows the middle of the new order with no sign that
  // the top of it moved.
  React.useEffect(() => {
    paged.setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowParams, sort?.key, sort?.dir]);

  // The breakdown follows the window but NOT the department/bucket filters —
  // it has to keep showing the whole window's split, or selecting a department
  // would leave it as the only bar on the strip and the counts in the dropdown
  // would all collapse to the one already chosen.
  const breakdown =
    metric === "expenses" ? (
      <ExpenseBucketPanel
        params={windowParams}
        filters={filters}
        onFiltersChange={setFilters}
      />
    ) : null;

  const filtered =
    Boolean(filters.department) || Boolean(filters.bucket);

  return (
    <Modal isOpen onClose={onClose} title={title} size="xl">
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : error ? (
        <p className="text-sm text-rose-600 py-8 text-center">Couldn&apos;t load details.</p>
      ) : rows.length === 0 ? (
        <div className="space-y-4">
          {breakdown}
          <p className="text-sm text-gray-400 italic py-8 text-center">
            {filtered
              ? "No records match these filters for the period."
              : "No records in this period."}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {breakdown}
          {/* The row count lives in the pagination caption below the table, so
              it is stated once. What belongs here is the total — which covers
              every matching row, not the page on screen, because a per-page
              subtotal on a financial list invites reading it as the total. */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-gray-500">
              {filtered ? "Filtered" : ""}
            </span>
            <p className="text-sm font-bold text-gray-900">
              Total: {formatINRExact(data?.total ?? 0)}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-100">
                  {cols.map((c) => (
                    <SortableTh
                      key={c.key}
                      label={c.label}
                      sortKey={c.sort ? c.key : undefined}
                      sort={sort}
                      onToggle={toggle}
                      align={c.align}
                      title={c.sortHint}
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                {paged.pageItems.map((row, i) => (
                  <tr key={paged.from + i} className="border-b border-gray-50">
                    {cols.map((c) => (
                      <td
                        key={c.key}
                        className={`py-2.5 px-2 text-xs text-gray-700 ${
                          c.align === "right" ? "text-right font-semibold text-gray-900" : ""
                        }`}
                      >
                        {c.render ? c.render(row) : txt(row[c.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={paged.page}
            pageCount={paged.pageCount}
            onPageChange={paged.setPage}
            total={paged.total}
            from={paged.from}
            to={paged.to}
            noun="records"
          />
          {/* E-224 — sorting is client-side, over the rows the server sent. Past
              the cap those are the most recent N, so ordering by amount
              ascending would show the smallest OF THOSE and read as the
              smallest of the period. Say it rather than let it pass. */}
          {data?.capped && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              This period has more than {(data.cap ?? 500).toLocaleString("en-IN")} records —
              only the most recent {(data.cap ?? 500).toLocaleString("en-IN")} are loaded, and
              sorting covers those. Narrow the window or the filters to see the rest.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
