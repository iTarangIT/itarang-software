"use client";

import React from "react";
import Link from "next/link";
import {
  TrendingDown,
  TrendingUp,
  Receipt,
  ArrowRight,
  ShoppingBag,
} from "lucide-react";
import { formatINRCompact } from "@/lib/format";
import { ManualSalesUpload } from "./ManualSalesUpload";

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

interface Props {
  purchasesMtd: number;
  salesMtd: number;
  otherExpensesMtd: number;
  recentInvoices?: RecentInvoice[];
  recentExpenses?: RecentExpense[];
  /** Open a drill-down for the clicked tile. When omitted, tiles are static. */
  onTileClick?: (metric: SnapshotMetric, title: string) => void;
}

const formatINR = (n: number) => formatINRCompact(n);

export function BusinessSnapshotPanel({
  purchasesMtd,
  salesMtd,
  otherExpensesMtd,
  recentInvoices = [],
  recentExpenses = [],
  onTileClick,
}: Props) {
  const netMtd = salesMtd - purchasesMtd - otherExpensesMtd;

  return (
    <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
      <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          <ShoppingBag className="w-4 h-4 text-brand-600" />
          Business Snapshot (MTD)
        </h3>
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
          value={formatINR(purchasesMtd)}
          tone="rose"
          onClick={onTileClick ? () => onTileClick("purchases", "Purchases from OEM (MTD)") : undefined}
        />
        <Tile
          testid="tile-sales-to-dealer"
          label="Sales to Dealer"
          value={formatINR(salesMtd)}
          tone="emerald"
          onClick={onTileClick ? () => onTileClick("sales", "Sales to Dealer (MTD)") : undefined}
        />
        <Tile
          testid="tile-other-expenses"
          label="Other Expenses"
          value={formatINR(otherExpensesMtd)}
          tone="amber"
          onClick={onTileClick ? () => onTileClick("expenses", "Other Expenses (MTD)") : undefined}
        />
      </div>

      <div data-testid="net-mtd" className="mt-4 p-3 rounded-xl bg-gray-50 border border-gray-100 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-gray-600 uppercase tracking-wider">
          Net (MTD)
        </span>
        <span
          data-testid="net-mtd-value"
          className={`text-base font-bold flex items-center gap-1 ${
            netMtd >= 0 ? "text-emerald-700" : "text-rose-700"
          }`}
        >
          {netMtd >= 0 ? (
            <TrendingUp className="w-4 h-4" />
          ) : (
            <TrendingDown className="w-4 h-4" />
          )}
          {formatINR(Math.abs(netMtd))}
        </span>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-wider font-bold text-gray-500 mb-2">
            Recent Zoho Invoices
          </p>
          {recentInvoices.length === 0 ? (
            <p data-testid="recent-invoices-empty" className="text-[11px] text-gray-400 italic">No invoices synced yet.</p>
          ) : (
            <ul data-testid="recent-invoices-list" className="divide-y divide-gray-50">
              {recentInvoices.map((inv) => (
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
            <ul data-testid="recent-expenses-list" className="divide-y divide-gray-50">
              {recentExpenses.map((exp) => (
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
          )}
        </div>
      </div>
    </div>
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
