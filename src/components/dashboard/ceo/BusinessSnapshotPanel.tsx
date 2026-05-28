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

interface Props {
  purchasesMtd: number;
  salesMtd: number;
  otherExpensesMtd: number;
  recentInvoices?: RecentInvoice[];
  recentExpenses?: RecentExpense[];
}

function formatINR(n: number): string {
  if (n >= 1_00_000) return `₹${(n / 1_00_000).toFixed(2)}L`;
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

export function BusinessSnapshotPanel({
  purchasesMtd,
  salesMtd,
  otherExpensesMtd,
  recentInvoices = [],
  recentExpenses = [],
}: Props) {
  const netMtd = salesMtd - purchasesMtd - otherExpensesMtd;

  return (
    <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
      <div className="flex items-center justify-between mb-5">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          <ShoppingBag className="w-4 h-4 text-brand-600" />
          Business Snapshot (MTD)
        </h3>
        <Link href="/ceo/expenses">
          <button className="text-[11px] font-semibold text-brand-700 hover:underline flex items-center gap-1">
            Review Expenses <ArrowRight className="w-3 h-3" />
          </button>
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="p-3 rounded-xl bg-rose-50/60 border border-rose-100/60">
          <p className="text-[10px] uppercase tracking-wider font-bold text-rose-700/70">
            Purchases from OEM
          </p>
          <p className="text-lg font-bold text-rose-900 mt-1">
            {formatINR(purchasesMtd)}
          </p>
        </div>
        <div className="p-3 rounded-xl bg-emerald-50/60 border border-emerald-100/60">
          <p className="text-[10px] uppercase tracking-wider font-bold text-emerald-700/70">
            Sales to Dealer
          </p>
          <p className="text-lg font-bold text-emerald-900 mt-1">
            {formatINR(salesMtd)}
          </p>
        </div>
        <div className="p-3 rounded-xl bg-amber-50/60 border border-amber-100/60">
          <p className="text-[10px] uppercase tracking-wider font-bold text-amber-700/70">
            Other Expenses
          </p>
          <p className="text-lg font-bold text-amber-900 mt-1">
            {formatINR(otherExpensesMtd)}
          </p>
        </div>
      </div>

      <div className="mt-4 p-3 rounded-xl bg-gray-50 border border-gray-100 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-gray-600 uppercase tracking-wider">
          Net (MTD)
        </span>
        <span
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
          <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 mb-2">
            Recent Zoho Invoices
          </p>
          {recentInvoices.length === 0 ? (
            <p className="text-[11px] text-gray-400 italic">No invoices synced yet.</p>
          ) : (
            <ul className="divide-y divide-gray-50">
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
          <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 mb-2 flex items-center gap-1">
            <Receipt className="w-3 h-3" />
            Recent Approved Expenses
          </p>
          {recentExpenses.length === 0 ? (
            <p className="text-[11px] text-gray-400 italic">No approved expenses yet.</p>
          ) : (
            <ul className="divide-y divide-gray-50">
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
