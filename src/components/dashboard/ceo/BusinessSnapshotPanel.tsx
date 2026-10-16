"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatINRCompact } from "@/lib/format";
import { DashCard, TABLE_HEAD } from "@/components/dashboard/redesign/primitives";
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

  // ID 89 — the redesign's card (DashCard) and tile look; same figures and
  // drill-downs, and the same test ids.
  return (
    <DashCard>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div ref={filterRef} className="relative flex items-center gap-2">
          <h2 className="text-lg font-bold text-brand-navy flex items-center gap-2">
            Business snapshot
            <span className="text-ink-muted/50 font-normal">·</span>
            <span className="text-[15px] font-semibold text-brand-royal">{label}</span>
            {isFetching && !isDefault ? (
              <span className="text-ink-muted font-normal">…</span>
            ) : null}
          </h2>
          <button
            type="button"
            data-testid="snapshot-filter-trigger"
            aria-label="Filter snapshot period"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className={cn(
              "inline-flex h-8 w-8 items-center justify-center rounded-[10px] border transition-colors",
              open || !isDefault
                ? "bg-brand-50 border-brand-200 text-brand-navy"
                : "bg-surface border-border text-ink-muted hover:text-brand-navy",
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
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <ManualSalesUpload />
          <span className="text-border">|</span>
          <Link href="/ceo/expenses" className="text-brand-navy hover:underline">
            Review expenses
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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

      <div className="mt-2 grid grid-cols-1 gap-4">
        <div>
          <p className={cn(TABLE_HEAD, "mb-2")}>Recent Zoho invoices</p>
          {recentInvoices.length === 0 ? (
            <p data-testid="recent-invoices-empty" className="text-xs text-ink-muted">No invoices synced yet.</p>
          ) : (
            <>
            <ul data-testid="recent-invoices-list" className="divide-y divide-border/60">
              {pagedInvoices.pageItems.map((inv) => (
                <li
                  key={inv.id}
                  className="py-2 flex items-center justify-between text-[13px]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-ink truncate">
                      {inv.customer_name || "—"}
                    </p>
                    <p className="text-[11px] text-ink-muted">
                      {inv.invoice_number || ""} · {inv.invoice_date || ""}
                    </p>
                  </div>
                  <span className="font-bold text-brand-navy tabular-nums ml-3">
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
          <p className={cn(TABLE_HEAD, "mb-2")}>Recent approved expenses</p>
          {recentExpenses.length === 0 ? (
            <p data-testid="recent-expenses-empty" className="text-xs text-ink-muted">No approved expenses yet.</p>
          ) : (
            <>
            <ul data-testid="recent-expenses-list" className="divide-y divide-border/60">
              {pagedExpenses.pageItems.map((exp) => (
                <li
                  key={exp.id}
                  className="py-2 flex items-center justify-between text-[13px]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-ink truncate">
                      {exp.category}
                    </p>
                    <p className="text-[11px] text-ink-muted truncate">
                      {exp.submitter_name || "—"}
                    </p>
                  </div>
                  <span className="font-bold text-brand-navy tabular-nums ml-3">
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
    </DashCard>
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

// KpiTile's look (primitives.tsx), with a coloured dot for money out / in.
const TILE_TONES = {
  rose: { dot: "bg-danger" },
  emerald: { dot: "bg-success" },
  amber: { dot: "bg-[#e0a100]" },
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
      <span className="flex items-center gap-2 text-[13px] font-semibold text-ink-muted">
        <span className={`h-2 w-2 shrink-0 rounded-full ${t.dot}`} aria-hidden />
        {label}
      </span>
      <p data-testid={`${testid}-value`} className="text-[24px] font-bold leading-tight tracking-tight text-brand-navy tabular-nums">
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
        className="flex flex-col gap-2 text-left rounded-2xl border border-border bg-surface p-[18px] shadow-card transition hover:border-brand-sky hover:shadow-md cursor-pointer"
      >
        {content}
      </button>
    );
  }
  return (
    <div data-testid={testid} className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-[18px] shadow-card">
      {content}
    </div>
  );
}
