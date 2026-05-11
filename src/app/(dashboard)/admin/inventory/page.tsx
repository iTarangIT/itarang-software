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
  serialNumber: string | null;
  inventoryType: string | null;
  category: string | null;
  subCategory: string | null;
  modelNumber: string | null;
  status: string;
  warehouseLocation: string | null;
  materialCode: string | null;
  supplierName: string | null;
  dealerId: string | null;
  dealerName: string | null;
  invoiceValue: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  createdAt: string;
}

interface KPIs {
  totalUnits: number;
  availableUnits: number;
  reservedUnits: number;
  soldUnits: number;
  writtenOffUnits: number;
  totalInvoiceValue: number;
}

interface InventoryFilters {
  dealerId: string;
  status: string;
  subCategory: string;
  q: string;
}

const ASSET_TYPE_OPTIONS = [
  { value: "", label: "All sub-categories" },
  { value: "battery", label: "Battery" },
  { value: "charger", label: "Charger" },
  { value: "DigitalSOC", label: "Digital SOC" },
  { value: "VoltSOC", label: "Volt SOC" },
  { value: "Harness", label: "Harness" },
];

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "available", label: "Available" },
  { value: "reserved", label: "Reserved" },
  { value: "sold", label: "Sold" },
  { value: "written_off", label: "Written off" },
  { value: "transferred_in", label: "Transferred in" },
  { value: "transferred_out", label: "Transferred out" },
];

export default function AdminInventoryDashboard() {
  const [dealers, setDealers] = useState<DealerOption[]>([]);
  const [filters, setFilters] = useState<InventoryFilters>({
    dealerId: "",
    status: "",
    subCategory: "",
    q: "",
  });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSerial, setActiveSerial] = useState<string | null>(null);

  const updateFilters = (patch: Partial<InventoryFilters>) => {
    setPage(1);
    setFilters((f) => ({ ...f, ...patch }));
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/dealers?limit=500");
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
        params.set("page", String(page));
        params.set("limit", String(limit));
        const res = await fetch(`/api/admin/inventory/all?${params.toString()}`);
        const json = await res.json();
        if (cancelled) return;
        if (json.success) {
          setRows(json.data.items || []);
          setKpis(json.data.kpis);
          setTotal(Number(json.data.total || 0));
        } else {
          setRows([]);
          setTotal(0);
          setError(json.error?.message || "Failed to load");
        }
      } catch {
        if (!cancelled) {
          setRows([]);
          setTotal(0);
          setError("Failed to load inventory");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filters, page, limit]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / limit)), [total, limit]);
  const pageStart = total === 0 ? 0 : (page - 1) * limit + 1;
  const pageEnd = total === 0 ? 0 : Math.min(total, page * limit);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const totalValueFmt = useMemo(
    () =>
      kpis
        ? `₹${Math.round(kpis.totalInvoiceValue).toLocaleString("en-IN")}`
        : "—",
    [kpis],
  );

  // Ageing Alert — count rows in inventory longer than 90/180 days (since created_at).
  const ageing = useMemo(() => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    let over90 = 0;
    let over180 = 0;
    for (const r of rows) {
      if (!r.createdAt) continue;
      if (r.status === "sold" || r.status === "written_off") continue;
      const age = (now - new Date(r.createdAt).getTime()) / day;
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
            value={kpis?.totalUnits ?? 0}
            tone="slate"
          />
          <KpiCard
            icon={<CheckCircle2 className="w-5 h-5" />}
            label="Available"
            value={kpis?.availableUnits ?? 0}
            tone="emerald"
          />
          <KpiCard
            icon={<Clock className="w-5 h-5" />}
            label="Reserved"
            value={kpis?.reservedUnits ?? 0}
            tone="amber"
          />
          <KpiCard
            icon={<ShoppingCart className="w-5 h-5" />}
            label="Sold"
            value={kpis?.soldUnits ?? 0}
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
                value={filters.dealerId}
                onChange={(e) => updateFilters({ dealerId: e.target.value })}
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
                onChange={(e) => updateFilters({ status: e.target.value })}
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
                Sub-category
              </label>
              <select
                value={filters.subCategory}
                onChange={(e) => updateFilters({ subCategory: e.target.value })}
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
                  onChange={(e) => updateFilters({ q: e.target.value })}
                  placeholder="Serial / material / model"
                  className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </div>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <label className="inline-flex items-center gap-2 text-xs text-gray-500 font-medium">
              Rows per page
              <select
                value={limit}
                onChange={(e) => {
                  setPage(1);
                  setLimit(Number(e.target.value));
                }}
                className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs bg-white text-gray-700"
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </label>
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
                        r.serialNumber && setActiveSerial(r.serialNumber)
                      }
                    >
                      <td className="px-3 py-2.5 font-mono text-[#0047AB] font-bold">
                        {r.serialNumber || "—"}
                      </td>
                      <td className="px-3 py-2.5">{r.modelNumber}</td>
                      <td className="px-3 py-2.5 text-gray-600">
                        {r.category} / {r.subCategory}
                      </td>
                      <td className="px-3 py-2.5">
                        {r.dealerName || dealerById.get(r.dealerId ?? "") || "—"}
                      </td>
                      <td className="px-3 py-2.5 text-gray-500">
                        {r.warehouseLocation || "—"}
                      </td>
                      <td className="px-3 py-2.5">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        ₹
                        {Number(r.invoiceValue ?? 0).toLocaleString("en-IN", {
                          maximumFractionDigits: 0,
                        })}
                      </td>
                      <td className="px-3 py-2.5 text-right text-gray-500">
                        {ageDaysLabel(r.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loading && total > 0 && (
            <div className="border-t border-gray-100 px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <p className="text-xs text-gray-500">
                Showing {pageStart} to {pageEnd} of {total} items
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  Previous
                </button>
                <span className="text-xs text-gray-600 min-w-[90px] text-center">
                  Page {page} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  Next
                </button>
              </div>
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
    sold: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
    written_off: "bg-gray-100 text-gray-600 ring-gray-600/20",
    transferred_in: "bg-cyan-50 text-cyan-700 ring-cyan-600/20",
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

function ageDaysLabel(createdAt: string | null): string {
  if (!createdAt) return "—";
  const days = Math.floor(
    (Date.now() - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000),
  );
  if (days < 0) return "—";
  return `${days}d`;
}
