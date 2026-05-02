"use client";

// BRD Step 4 upstream: admin inventory management dashboard.
// KPIs + filterable list backed by /api/admin/inventory/all.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

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
  { value: "sold", label: "Sold" },
  { value: "write_off", label: "Written off" },
];

export default function AdminInventoryDashboard() {
  const [dealers, setDealers] = useState<DealerOption[]>([]);
  const [filters, setFilters] = useState({ dealer_id: "", status: "", asset_type: "", q: "" });
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      } catch (e) {
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

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Admin Inventory</h1>
          <p className="text-sm text-gray-500">
            Upload, assign, and manage dealer inventory.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/admin/inventory/upload"
            className="px-4 py-2 bg-emerald-600 text-white rounded text-sm font-bold hover:bg-emerald-700"
          >
            Bulk upload
          </Link>
          <Link
            href="/admin/inventory/add"
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-bold hover:bg-blue-700"
          >
            Add item
          </Link>
        </div>
      </header>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-sm">
          {error}
        </div>
      )}

      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard label="Total units" value={kpis?.total ?? 0} />
        <KpiCard label="Available" value={kpis?.available ?? 0} tone="green" />
        <KpiCard label="Reserved" value={kpis?.reserved ?? 0} tone="amber" />
        <KpiCard label="Sold" value={kpis?.sold ?? 0} tone="blue" />
        <KpiCard label="Total value" value={totalValueFmt} />
      </section>

      <section className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase mb-1">
              Dealer
            </label>
            <select
              value={filters.dealer_id}
              onChange={(e) => setFilters((f) => ({ ...f, dealer_id: e.target.value }))}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
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
            <label className="block text-xs font-bold text-gray-500 uppercase mb-1">
              Status
            </label>
            <select
              value={filters.status}
              onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase mb-1">
              Asset type
            </label>
            <select
              value={filters.asset_type}
              onChange={(e) => setFilters((f) => ({ ...f, asset_type: e.target.value }))}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
            >
              {ASSET_TYPE_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase mb-1">
              Search
            </label>
            <input
              value={filters.q}
              onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
              placeholder="Serial / HSN / model"
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50">
              <tr className="text-left">
                <th className="px-3 py-2">Serial</th>
                <th className="px-3 py-2">Model</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Dealer</th>
                <th className="px-3 py-2">Warehouse</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Value</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-gray-400">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-gray-400">
                    No inventory matching filters.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono">{r.serial_number || "—"}</td>
                  <td className="px-3 py-2">{r.model_type}</td>
                  <td className="px-3 py-2">
                    {r.asset_category} / {r.asset_type}
                  </td>
                  <td className="px-3 py-2">{r.dealer_name || "—"}</td>
                  <td className="px-3 py-2">{r.warehouse_location || "—"}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    ₹
                    {Number(r.final_amount ?? 0).toLocaleString("en-IN", {
                      maximumFractionDigits: 0,
                    })}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      href={`/admin/inventory/${r.id}`}
                      className="text-blue-600 hover:underline"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function KpiCard({
  label,
  value,
  tone = "gray",
}: {
  label: string;
  value: number | string;
  tone?: "gray" | "green" | "amber" | "blue";
}) {
  const colorMap = {
    gray: "bg-white border-gray-200",
    green: "bg-emerald-50 border-emerald-200",
    amber: "bg-amber-50 border-amber-200",
    blue: "bg-blue-50 border-blue-200",
  };
  return (
    <div className={`border rounded-lg p-3 ${colorMap[tone]}`}>
      <div className="text-xs uppercase tracking-wider text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    available: "bg-emerald-100 text-emerald-800",
    reserved: "bg-amber-100 text-amber-800",
    sold: "bg-blue-100 text-blue-800",
    write_off: "bg-gray-100 text-gray-600",
    in_stock: "bg-emerald-100 text-emerald-800",
  };
  return (
    <span
      className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
        map[status] || "bg-gray-100 text-gray-700"
      }`}
    >
      {status}
    </span>
  );
}
