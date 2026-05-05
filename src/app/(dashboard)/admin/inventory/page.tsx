"use client";

// BRD V2 §5.0.7 — Admin Inventory Dashboard.
// Network Summary cards + Ageing Alert + Quick Actions + cross-dealer list +
// click-to-open Battery Detail Card modal.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Package,
  CheckCircle2,
  Clock,
  ShoppingCart,
  Banknote,
  AlertTriangle,
  Search,
  Loader2,
  Upload,
  Plus,
  ArrowRightLeft,
  FileBarChart2,
  X,
} from "lucide-react";

import InventoryDetailCard from "@/components/inventory/InventoryDetailCard";

interface DealerOption {
  id: string;
  business_entity_name: string;
}

interface InventoryRow {
  id: string;
  serial_number: string | null;
  asset_category: string;
  asset_type: string;
  model_type: string;
  status: string;
  warehouse_location: string | null;
  hsn_code: string | null;
  oem_name: string | null;
  dealer_id: string | null;
  dealer_name: string | null;
  inventory_amount: string | null;
  final_amount: string | null;
  iot_imei_no: string | null;
  oem_invoice_number: string | null;
  oem_invoice_date: string | null;
  created_at: string;
}

interface KPIs {
  total: number;
  available: number;
  reserved: number;
  sold: number;
  write_off: number;
  total_value: number;
}

const ASSET_TYPE_OPTIONS = [
  { value: "", label: "All asset types" },
  { value: "Battery", label: "Battery" },
  { value: "Charger", label: "Charger" },
  { value: "Cable", label: "Cable" },
  { value: "Helmet", label: "Helmet" },
];

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "available", label: "Available" },
  { value: "reserved", label: "Reserved" },
  { value: "dispatched", label: "Dispatched" },
  { value: "sold", label: "Sold" },
  { value: "write_off", label: "Written off" },
  { value: "transferred_out", label: "Transferred out" },
];

export default function AdminInventoryDashboard() {
  const [dealers, setDealers] = useState<DealerOption[]>([]);
  const [filters, setFilters] = useState({
    dealer_id: "",
    status: "",
    asset_type: "",
    q: "",
  });
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSerial, setActiveSerial] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/dealers?status=active&limit=500");
        const json = await res.json();
        if (json.success) setDealers(json.data || []);
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        Object.entries(filters).forEach(([k, v]) => {
          if (v) params.set(k, v);
        });
        const res = await fetch(`/api/admin/inventory/all?${params.toString()}`);
        const json = await res.json();
        if (cancelled) return;
        if (json.success) {
          setRows(json.data.rows);
          setKpis(json.data.kpis);
        } else {
          setError(json.error?.message || "Failed to load");
        }
      } catch {
        if (!cancelled) setError("Failed to load inventory");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const totalValueFmt = useMemo(
    () =>
      kpis
        ? `₹${Math.round(kpis.total_value).toLocaleString("en-IN")}`
        : "—",
    [kpis],
  );

  // BRD §5.0.7 — Ageing Alert. Count rows with invoice date older than 90/180 days.
  const ageing = useMemo(() => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    let over90 = 0;
    let over180 = 0;
    for (const r of rows) {
      if (!r.oem_invoice_date) continue;
      if (r.status === "sold" || r.status === "write_off") continue;
      const age = (now - new Date(r.oem_invoice_date).getTime()) / day;
      if (age > 180) over180++;
      else if (age > 90) over90++;
    }
    return { over90, over180 };
  }, [rows]);

  const dealerById = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of dealers) m.set(d.id, d.business_entity_name);
    return m;
  }, [dealers]);

  return (
    <div className="min-h-screen bg-[#F8F9FB]">
      <div className="max-w-[1400px] mx-auto px-6 py-8 space-y-6">
        {/* ─── Header ──────────────────────────────────────────────────── */}
        <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <h1 className="text-[28px] font-black text-gray-900 tracking-tight">
              Inventory Network
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Cross-dealer view of every battery, charger, and paraphernalia unit.
              BRD §5.0.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/admin/inventory/upload"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] transition-colors shadow-sm"
            >
              <Upload className="w-4 h-4" /> Bulk Upload
            </Link>
            <Link
              href="/admin/inventory/add"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 text-gray-800 rounded-xl text-sm font-bold hover:bg-gray-50 transition-colors shadow-sm"
            >
              <Plus className="w-4 h-4" /> Add Item
            </Link>
          </div>
        </header>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* ─── Network Summary ────────────────────────────────────────── */}
        <section className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <KpiCard
            icon={<Package className="w-5 h-5" />}
            label="Total units"
            value={kpis?.total ?? 0}
            tone="slate"
          />
          <KpiCard
            icon={<CheckCircle2 className="w-5 h-5" />}
            label="Available"
            value={kpis?.available ?? 0}
            tone="emerald"
          />
          <KpiCard
            icon={<Clock className="w-5 h-5" />}
            label="Reserved"
            value={kpis?.reserved ?? 0}
            tone="amber"
          />
          <KpiCard
            icon={<ShoppingCart className="w-5 h-5" />}
            label="Sold"
            value={kpis?.sold ?? 0}
            tone="blue"
          />
          <KpiCard
            icon={<Banknote className="w-5 h-5" />}
            label="Network value"
            value={totalValueFmt}
            tone="indigo"
          />
        </section>

        {/* ─── Ageing Alert ───────────────────────────────────────────── */}
        {(ageing.over90 > 0 || ageing.over180 > 0) && (
          <section className="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 bg-amber-500 rounded-xl flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-5 h-5 text-white" />
              </div>
              <div>
                <p className="text-sm font-bold text-amber-900">
                  Ageing inventory needs attention
                </p>
                <p className="text-xs text-amber-800 mt-0.5">
                  <span className="font-bold">{ageing.over90}</span> units in stock
                  for 91–180 days · <span className="font-bold">{ageing.over180}</span> units{" "}
                  past 180 days. Prioritise dispatch or transfer.
                </p>
              </div>
            </div>
            <Link
              href="/admin/inventory/ageing-report"
              className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-amber-300 text-amber-900 rounded-xl text-xs font-bold hover:bg-amber-100 transition-colors flex-shrink-0"
            >
              <FileBarChart2 className="w-4 h-4" /> Open Ageing Report
            </Link>
          </section>
        )}

        {/* ─── Quick Actions ──────────────────────────────────────────── */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <QuickAction
            href="/admin/inventory/upload"
            icon={<Upload className="w-4 h-4" />}
            label="Upload Inventory"
          />
          <QuickAction
            href="/admin/inventory/transfer"
            icon={<ArrowRightLeft className="w-4 h-4" />}
            label="Inter-Dealer Transfer"
          />
          <QuickAction
            href="/admin/inventory/ageing-report"
            icon={<FileBarChart2 className="w-4 h-4" />}
            label="Ageing Report"
          />
          <QuickAction
            href="/admin/inventory/add"
            icon={<Plus className="w-4 h-4" />}
            label="Add Single Item"
          />
        </section>

        {/* ─── Filters ────────────────────────────────────────────────── */}
        <section className="bg-white border border-gray-100 rounded-2xl p-5 shadow-sm">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-[10px] uppercase tracking-wider font-bold text-gray-500 mb-1">
                Dealer
              </label>
              <select
                value={filters.dealer_id}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, dealer_id: e.target.value }))
                }
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
              >
                <option value="">All dealers</option>
                {dealers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.business_entity_name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider font-bold text-gray-500 mb-1">
                Status
              </label>
              <select
                value={filters.status}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, status: e.target.value }))
                }
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider font-bold text-gray-500 mb-1">
                Asset type
              </label>
              <select
                value={filters.asset_type}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, asset_type: e.target.value }))
                }
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
              >
                {ASSET_TYPE_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider font-bold text-gray-500 mb-1">
                Search
              </label>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  value={filters.q}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, q: e.target.value }))
                  }
                  placeholder="Serial / HSN / model"
                  className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </div>
            </div>
          </div>
        </section>

        {/* ─── Inventory Table ────────────────────────────────────────── */}
        <section className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-[#0047AB]" />
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center py-16 text-gray-400 text-sm">
              No inventory matches the current filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500 font-bold">
                  <tr>
                    <th className="px-3 py-3 text-left">Serial</th>
                    <th className="px-3 py-3 text-left">Model</th>
                    <th className="px-3 py-3 text-left">Type</th>
                    <th className="px-3 py-3 text-left">Dealer</th>
                    <th className="px-3 py-3 text-left">Warehouse</th>
                    <th className="px-3 py-3 text-left">Status</th>
                    <th className="px-3 py-3 text-right">Value</th>
                    <th className="px-3 py-3 text-right">Age</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      className="hover:bg-blue-50/30 cursor-pointer transition-colors"
                      onClick={() =>
                        r.serial_number && setActiveSerial(r.serial_number)
                      }
                    >
                      <td className="px-3 py-2.5 font-mono text-[#0047AB] font-bold">
                        {r.serial_number || "—"}
                      </td>
                      <td className="px-3 py-2.5">{r.model_type}</td>
                      <td className="px-3 py-2.5 text-gray-600">
                        {r.asset_category} / {r.asset_type}
                      </td>
                      <td className="px-3 py-2.5">
                        {r.dealer_name || dealerById.get(r.dealer_id ?? "") || "—"}
                      </td>
                      <td className="px-3 py-2.5 text-gray-500">
                        {r.warehouse_location || "—"}
                      </td>
                      <td className="px-3 py-2.5">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        ₹
                        {Number(r.final_amount ?? 0).toLocaleString("en-IN", {
                          maximumFractionDigits: 0,
                        })}
                      </td>
                      <td className="px-3 py-2.5 text-right text-gray-500">
                        {ageDaysLabel(r.oem_invoice_date)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* ─── Detail Card Modal ─────────────────────────────────────────── */}
      {activeSerial && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-start sm:items-center justify-center p-4 overflow-auto"
          onClick={() => setActiveSerial(null)}
        >
          <div
            className="bg-white rounded-2xl max-w-3xl w-full shadow-2xl my-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="font-black text-lg text-gray-900">
                Inventory Detail
              </h2>
              <button
                onClick={() => setActiveSerial(null)}
                className="p-1 rounded-lg hover:bg-gray-100"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <InventoryDetailCard serial={activeSerial} />
          </div>
        </div>
      )}
    </div>
  );
}

function KpiCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  tone: "slate" | "emerald" | "amber" | "blue" | "indigo";
}) {
  const palette: Record<typeof tone, string> = {
    slate: "bg-slate-50 text-slate-700",
    emerald: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-700",
    blue: "bg-blue-50 text-blue-700",
    indigo: "bg-indigo-50 text-indigo-700",
  };
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
      <div
        className={`w-9 h-9 rounded-xl flex items-center justify-center mb-3 ${palette[tone]}`}
      >
        {icon}
      </div>
      <p className="text-2xl font-black text-gray-900">{value}</p>
      <p className="text-xs font-medium text-gray-400 mt-1">{label}</p>
    </div>
  );
}

function QuickAction({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="bg-white border border-gray-100 rounded-2xl p-4 flex items-center gap-3 hover:border-[#0047AB] hover:shadow-md transition-all shadow-sm"
    >
      <div className="w-9 h-9 rounded-xl bg-[#0047AB]/10 text-[#0047AB] flex items-center justify-center">
        {icon}
      </div>
      <span className="text-sm font-bold text-gray-900">{label}</span>
    </Link>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    available: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
    reserved: "bg-amber-50 text-amber-700 ring-amber-600/20",
    dispatched: "bg-blue-50 text-blue-700 ring-blue-600/20",
    sold: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
    write_off: "bg-gray-100 text-gray-600 ring-gray-600/20",
    in_stock: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
    transferred_out: "bg-purple-50 text-purple-700 ring-purple-600/20",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset ${
        map[status] || "bg-gray-100 text-gray-600 ring-gray-600/20"
      }`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function ageDaysLabel(invoiceDate: string | null): string {
  if (!invoiceDate) return "—";
  const days = Math.floor(
    (Date.now() - new Date(invoiceDate).getTime()) / (24 * 60 * 60 * 1000),
  );
  if (days < 0) return "—";
  return `${days}d`;
}
