"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import {
  Receipt,
  ArrowRight,
  ShoppingBag,
  SlidersHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatINRCompact } from "@/lib/format";
import { Pagination, usePagination } from "@/components/shared/Pagination";
import { ManualSalesUpload } from "./ManualSalesUpload";
import { MonthCalendar } from "./MonthCalendar";

/** Rows per page in the two recent lists — they are a glance, not a ledger. */
const RECENT_PAGE_SIZE = 5;

interface RecentInvoice {
  id: string;
  invoice_number: string | null;
  customer_name: string | null;
  invoice_date: string | null;
  total: string | null;
  status: string | null;
}

interface RecentExpense {
  id: string;
  category: string;
  amount: string;
  approved_at: string | null;
  submitter_name: string | null;
}

type SnapshotMetric = "purchases" | "sales" | "expenses";

/** Active period for the whole snapshot. */
type Selection = { kind: "mtd" } | { kind: "fy" } | { kind: "month"; value: string };

interface Props {
  purchasesMtd: number;
  salesMtd: number;
  otherExpensesMtd: number;
  recentInvoices?: RecentInvoice[];
  recentExpenses?: RecentExpense[];
  /**
   * Open a drill-down for the clicked tile. `params` is the query string for the
   * active window (e.g. "period=fy" / "month=2026-06") so the drill-down matches
   * the filtered figure. When omitted, tiles are static.
   */
  onTileClick?: (metric: SnapshotMetric, title: string, params: string) => void;
}

const formatINR = (n: number) => formatINRCompact(n);

interface SnapshotSummary {
  purchases: number;
  sales: number;
  otherExpenses: number;
  net: number;
  period: string;
  label: string;
}

export function BusinessSnapshotPanel({
  purchasesMtd,
  salesMtd,
  otherExpensesMtd,
  recentInvoices = [],
  recentExpenses = [],
  onTileClick,
}: Props) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<Selection>({ kind: "mtd" });
  const filterRef = useRef<HTMLDivElement>(null);

  // E-219 — both recent lists are paged five at a time. They sit in a narrow
  // column beside the snapshot tiles, so they get the compact control (a
  // "2 / 5" counter instead of page buttons) rather than wrapping onto a
  // second line.
  const pagedInvoices = usePagination(recentInvoices, RECENT_PAGE_SIZE);
  const pagedExpenses = usePagination(recentExpenses, RECENT_PAGE_SIZE);

  // Close the popover on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const isDefault = selection.kind === "mtd";
  const queryParam =
    selection.kind === "month"
      ? `month=${selection.value}`
      : `period=${selection.kind}`;

  // Only a non-default window hits the API; "This month" uses the live props so
  // it always matches the dashboard headline exactly.
  const { data, isFetching } = useQuery({
    queryKey: ["ceo-snapshot-summary", queryParam],
    enabled: !isDefault,
    queryFn: async () => {
      const r = await fetch(`/api/dashboard/ceo/snapshot-summary?${queryParam}`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error("Failed to load snapshot");
      const j = await r.json();
      return j.data as SnapshotSummary;
    },
    placeholderData: (prev) => prev,
  });

  const purchases = isDefault ? purchasesMtd : data?.purchases ?? purchasesMtd;
  const sales = isDefault ? salesMtd : data?.sales ?? salesMtd;
  const otherExpenses = isDefault
    ? otherExpensesMtd
    : data?.otherExpenses ?? otherExpensesMtd;

  const monthLabel =
    selection.kind === "month"
      ? new Date(`${selection.value}-01T00:00:00`).toLocaleDateString("en-IN", {
          month: "short",
          year: "numeric",
        })
      : "";
  const label =
    selection.kind === "fy"
      ? "Financial year"
      : selection.kind === "month"
        ? data?.label ?? monthLabel
        : "This month";

  return (
    <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
      <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
        <div ref={filterRef} className="relative flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <ShoppingBag className="w-4 h-4 text-brand-600" />
            Business Snapshot
            <span className="text-gray-300 font-normal">·</span>
            <span className="text-brand-700">{label}</span>
            {isFetching && !isDefault ? (
              <span className="text-gray-400 font-normal">…</span>
            ) : null}
          </h3>
          <button
            type="button"
            data-testid="snapshot-filter-trigger"
            aria-label="Filter snapshot period"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className={cn(
              "p-1.5 rounded-lg border transition-colors",
              open || !isDefault
                ? "bg-brand-50 border-brand-200 text-brand-600"
                : "bg-white border-gray-200 text-gray-400 hover:text-brand-600 hover:border-brand-100",
            )}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </button>

          <AnimatePresence>
            {open && (
              <motion.div
                initial={{ opacity: 0, y: -6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.97 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
                data-testid="snapshot-filter-popover"
                className="absolute left-0 top-9 z-50 w-72 origin-top-left rounded-2xl bg-white border border-gray-100 shadow-xl shadow-gray-200/60 p-4"
              >
                <p className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">
                  Period
                </p>
                <div className="grid grid-cols-2 gap-1 p-1 bg-gray-100 rounded-xl mb-3">
                  <PeriodButton
                    label="This month"
                    active={selection.kind === "mtd"}
                    onClick={() => setSelection({ kind: "mtd" })}
                  />
                  <PeriodButton
                    label="Financial year"
                    active={selection.kind === "fy"}
                    onClick={() => setSelection({ kind: "fy" })}
                  />
                </div>

                <MonthCalendar
                  value={selection.kind === "month" ? selection.value : null}
                  onSelect={(value) => {
                    setSelection({ kind: "month", value });
                    setOpen(false);
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-semibold">
          <ManualSalesUpload />
          <span className="text-gray-200">|</span>
          <Link
            href="/ceo/expenses"
            className="text-brand-700 hover:underline flex items-center gap-1"
          >
            Review Expenses <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Tile
          testid="tile-oem-purchases"
          label="Purchases from OEM"
          value={formatINR(purchases)}
          tone="rose"
          onClick={onTileClick ? () => onTileClick("purchases", `Purchases from OEM · ${label}`, queryParam) : undefined}
        />
        <Tile
          testid="tile-sales-to-dealer"
          label="Sales to Dealer"
          value={formatINR(sales)}
          tone="emerald"
          onClick={onTileClick ? () => onTileClick("sales", `Sales to Dealer · ${label}`, queryParam) : undefined}
        />
        <Tile
          testid="tile-other-expenses"
          label="Other Expenses"
          value={formatINR(otherExpenses)}
          tone="amber"
          onClick={onTileClick ? () => onTileClick("expenses", `Other Expenses · ${label}`, queryParam) : undefined}
        />
      </div>

      {/* E-224 — the "Net · <period>" strip was removed here. Realization
          (revenue − expense) is the headline KPI at the top of the page and is
          the figure the CEO acts on; a second, differently-derived net beneath
          the snapshot tiles invited the two being read as the same number. */}

      <div className="mt-5 grid grid-cols-1 gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-wider font-bold text-gray-500 mb-2">
            Recent Zoho Invoices
          </p>
          {recentInvoices.length === 0 ? (
            <p data-testid="recent-invoices-empty" className="text-[11px] text-gray-400 italic">No invoices synced yet.</p>
          ) : (
            <>
            <ul data-testid="recent-invoices-list" className="divide-y divide-gray-50">
              {pagedInvoices.pageItems.map((inv) => (
                <li
                  key={inv.id}
                  className="py-2 flex items-center justify-between text-[12px]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-900 truncate">
                      {inv.customer_name || "—"}
                    </p>
                    <p className="text-[10px] text-gray-400">
                      {inv.invoice_number || ""} · {inv.invoice_date || ""}
                    </p>
                  </div>
                  <span className="font-bold text-gray-800 ml-3">
                    {formatINR(Number(inv.total || 0))}
                  </span>
                </li>
              ))}
            </ul>
            <Pagination
              page={pagedInvoices.page}
              pageCount={pagedInvoices.pageCount}
              onPageChange={pagedInvoices.setPage}
              total={pagedInvoices.total}
              from={pagedInvoices.from}
              to={pagedInvoices.to}
              noun="invoices"
              compact
            />
            </>
          )}
        </div>

        <div>
          <p className="text-[11px] uppercase tracking-wider font-bold text-gray-500 mb-2 flex items-center gap-1">
            <Receipt className="w-3 h-3" />
            Recent Approved Expenses
          </p>
          {recentExpenses.length === 0 ? (
            <p data-testid="recent-expenses-empty" className="text-[11px] text-gray-400 italic">No approved expenses yet.</p>
          ) : (
            <>
            <ul data-testid="recent-expenses-list" className="divide-y divide-gray-50">
              {pagedExpenses.pageItems.map((exp) => (
                <li
                  key={exp.id}
                  className="py-2 flex items-center justify-between text-[12px]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-900 truncate">
                      {exp.category}
                    </p>
                    <p className="text-[10px] text-gray-400 truncate">
                      {exp.submitter_name || "—"}
                    </p>
                  </div>
                  <span className="font-bold text-gray-800 ml-3">
                    {formatINR(Number(exp.amount || 0))}
                  </span>
                </li>
              ))}
            </ul>
            <Pagination
              page={pagedExpenses.page}
              pageCount={pagedExpenses.pageCount}
              onPageChange={pagedExpenses.setPage}
              total={pagedExpenses.total}
              from={pagedExpenses.from}
              to={pagedExpenses.to}
              noun="expenses"
              compact
            />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PeriodButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "py-1.5 px-2 rounded-lg text-xs font-semibold transition-colors",
        active ? "bg-white text-brand-700 shadow-sm" : "text-gray-500 hover:text-gray-700",
      )}
    >
      {label}
    </button>
  );
}

const TILE_TONES = {
  rose: { bg: "bg-rose-50/60 border-rose-100/60", label: "text-rose-700/70", value: "text-rose-900" },
  emerald: {
    bg: "bg-emerald-50/60 border-emerald-100/60",
    label: "text-emerald-700/70",
    value: "text-emerald-900",
  },
  amber: { bg: "bg-amber-50/60 border-amber-100/60", label: "text-amber-700/70", value: "text-amber-900" },
} as const;

function Tile({
  testid,
  label,
  value,
  tone,
  onClick,
}: {
  testid: string;
  label: string;
  value: string;
  tone: keyof typeof TILE_TONES;
  onClick?: () => void;
}) {
  const t = TILE_TONES[tone];
  const content = (
    <>
      <p className={`text-[11px] uppercase tracking-wider font-bold ${t.label}`}>{label}</p>
      <p data-testid={`${testid}-value`} className={`text-lg font-bold ${t.value} mt-1`}>
        {value}
      </p>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        data-testid={testid}
        onClick={onClick}
        className={`text-left p-3 rounded-xl border ${t.bg} transition-all hover:shadow-sm hover:-translate-y-0.5 cursor-pointer`}
      >
        {content}
      </button>
    );
  }
  return (
    <div data-testid={testid} className={`p-3 rounded-xl border ${t.bg}`}>
      {content}
    </div>
  );
}
