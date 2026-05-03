"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Loader2,
  Search,
  CheckCircle2,
  XCircle,
  Clock,
  Package,
  User,
} from "lucide-react";

// BRD V2 Part E — admin Step 4 product-review queue.
// Lists leads whose dealers submitted a product selection. Default tab shows
// "Pending" (no loan decision yet). Each row links to the detail panel at
// /admin/product-review/[leadId].

type Row = {
  lead_id: string;
  owner_name: string;
  dealer_name: string;
  kyc_status: string;
  payment_mode: string;
  admin_decision: string;
  status: "pending" | "sanctioned" | "rejected";
  battery_serial: string | null;
  charger_serial: string | null;
  final_price: string | null;
  submitted_at: string | null;
  loan_amount: string | null;
  rejection_reason: string | null;
};

type KPIs = {
  total: number;
  pending: number;
  sanctioned: number;
  rejected: number;
};

const STATUS_TABS = ["pending", "all", "sanctioned", "rejected"] as const;
const PAYMENT_TABS = ["", "finance", "cash"] as const;

export default function AdminProductReviewQueuePage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [kpis, setKpis] = useState<KPIs>({ total: 0, pending: 0, sanctioned: 0, rejected: 0 });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_TABS)[number]>("pending");
  const [paymentFilter, setPaymentFilter] = useState<(typeof PAYMENT_TABS)[number]>("");
  const [search, setSearch] = useState("");

  const fetchRows = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const params = new URLSearchParams({ status: statusFilter });
      if (paymentFilter) params.set("payment_mode", paymentFilter);
      if (search) params.set("q", search);
      const res = await fetch(`/api/admin/product-reviews?${params.toString()}`);
      const json = await res.json();
      if (json.success) {
        setRows(json.data.rows);
        setKpis(json.data.kpis);
      }
    } catch {
      /* silent */
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchRows();
  }, [statusFilter, paymentFilter, search]);

  useEffect(() => {
    const interval = setInterval(() => fetchRows(true), 30000);
    return () => clearInterval(interval);
  }, [statusFilter, paymentFilter, search]);

  return (
    <div className="min-h-screen bg-[#F8F9FB]">
      <div className="max-w-[1400px] mx-auto px-6 py-8">
        <header className="mb-8">
          <h1 className="text-[28px] font-black text-gray-900 tracking-tight">
            Product Review
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Review dealer-submitted product selections and decide loan sanction.
          </p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <KPICard icon={<Package className="w-5 h-5" />} label="Total Selections" value={kpis.total} color="blue" />
          <KPICard icon={<Clock className="w-5 h-5" />} label="Pending Review" value={kpis.pending} color="amber" />
          <KPICard icon={<CheckCircle2 className="w-5 h-5" />} label="Sanctioned" value={kpis.sanctioned} color="green" />
          <KPICard icon={<XCircle className="w-5 h-5" />} label="Rejected" value={kpis.rejected} color="red" />
        </div>

        <div className="flex items-center gap-3 mb-4 flex-wrap">
          {STATUS_TABS.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-4 py-2 rounded-xl text-sm font-bold capitalize ${
                statusFilter === s
                  ? "bg-[#0047AB] text-white"
                  : "bg-white border border-gray-200 text-gray-600"
              }`}
            >
              {s === "pending" ? "Needs Review" : s}
            </button>
          ))}
          <div className="flex-1" />
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search lead, owner, dealer..."
              className="pl-10 pr-4 py-2 border border-gray-200 rounded-xl text-sm w-64 outline-none focus:border-[#1D4ED8]"
            />
          </div>
        </div>

        <div className="flex items-center gap-2 mb-6">
          <span className="text-xs font-bold text-gray-500 uppercase mr-1">Payment:</span>
          {PAYMENT_TABS.map((p) => (
            <button
              key={p || "all"}
              onClick={() => setPaymentFilter(p)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold capitalize ${
                paymentFilter === p
                  ? "bg-gray-900 text-white"
                  : "bg-white border border-gray-200 text-gray-600"
              }`}
            >
              {p || "All"}
            </button>
          ))}
        </div>

        <div className="bg-white rounded-[20px] border border-gray-100 shadow-sm overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-8 h-8 animate-spin text-[#1D4ED8]" />
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center py-20 text-gray-400">
              <Package className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="font-bold">No product selections to review</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr className="text-left">
                    <th className="px-4 py-3 font-bold text-gray-500 text-xs uppercase">Lead</th>
                    <th className="px-4 py-3 font-bold text-gray-500 text-xs uppercase">Dealer</th>
                    <th className="px-4 py-3 font-bold text-gray-500 text-xs uppercase">Payment</th>
                    <th className="px-4 py-3 font-bold text-gray-500 text-xs uppercase">Battery / Charger</th>
                    <th className="px-4 py-3 font-bold text-gray-500 text-xs uppercase text-right">Final Price</th>
                    <th className="px-4 py-3 font-bold text-gray-500 text-xs uppercase">Submitted</th>
                    <th className="px-4 py-3 font-bold text-gray-500 text-xs uppercase">Status</th>
                    <th className="px-4 py-3 font-bold text-gray-500 text-xs uppercase"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.lead_id} className="border-t border-gray-100 hover:bg-gray-50/60">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center">
                            <User className="w-4 h-4 text-blue-600" />
                          </div>
                          <div>
                            <div className="font-bold text-gray-900">{r.owner_name}</div>
                            <div className="text-[10px] text-gray-400 font-mono">{r.lead_id}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-700">{r.dealer_name}</td>
                      <td className="px-4 py-3">
                        <PaymentBadge mode={r.payment_mode} />
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600 font-mono">
                        <div>{r.battery_serial || "—"}</div>
                        <div className="text-gray-400">{r.charger_serial || "—"}</div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-bold text-gray-900">
                        ₹{Number(r.final_price ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {r.submitted_at ? new Date(r.submitted_at).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/admin/product-review/${r.lead_id}`}
                          className="px-3 py-1.5 bg-[#0047AB] text-white rounded-lg text-[11px] font-bold hover:bg-[#003580]"
                        >
                          Review
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KPICard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: "blue" | "green" | "amber" | "red";
}) {
  const colorClasses: Record<typeof color, string> = {
    blue: "bg-blue-50 text-blue-600",
    green: "bg-green-50 text-green-600",
    amber: "bg-amber-50 text-amber-600",
    red: "bg-red-50 text-red-600",
  };
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${colorClasses[color]}`}>
        {icon}
      </div>
      <p className="text-2xl font-black text-gray-900">{value}</p>
      <p className="text-xs font-medium text-gray-400 mt-1">{label}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: Row["status"] }) {
  const map: Record<Row["status"], string> = {
    pending: "bg-amber-50 text-amber-700",
    sanctioned: "bg-green-50 text-green-700",
    rejected: "bg-red-50 text-red-700",
  };
  return (
    <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ${map[status]}`}>
      {status}
    </span>
  );
}

function PaymentBadge({ mode }: { mode: string }) {
  const norm = mode?.toLowerCase();
  const map: Record<string, string> = {
    finance: "bg-purple-50 text-purple-700",
    cash: "bg-emerald-50 text-emerald-700",
    upfront: "bg-emerald-50 text-emerald-700",
  };
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
        map[norm] || "bg-gray-100 text-gray-600"
      }`}
    >
      {mode || "—"}
    </span>
  );
}
