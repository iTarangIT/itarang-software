"use client";

// BRD V2 §5.3 — Inventory Ageing Report.
// Filter bar + bucket KPIs + sortable table + CSV download.

import { useEffect, useMemo, useState } from "react";
import { Download, AlertTriangle, Loader2 } from "lucide-react";

interface DealerOption {
  id: string;
  business_entity_name: string;
}

interface AgeingRow {
  battery_id: string;
  material_code: string | null;
  dealer_id: string | null;
  dealer_name: string | null;
  category: string | null;
  sub_category: string | null;
  model_number: string | null;
  serial_number: string | null;
  sold_date: string | null;
  status: string;
  invoice_value: string | null;
  star_rating: number | null;
  soc_percent: string | null;
  imei_id: string | null;
  iot_enabled: boolean;
  oem_warranty_date: string | null;
  oem_warranty_expiry: string | null;
  inventory_age_days: number;
}

interface Buckets {
  "0-30": number;
  "31-90": number;
  "91-180": number;
  "181+": number;
}

const CATEGORY_OPTIONS = [
  { value: "", label: "All categories" },
  { value: "battery", label: "Battery" },
  { value: "charger", label: "Charger" },
  { value: "paraphernalia", label: "Paraphernalia" },
];

export default function AgeingReportPage() {
  const [dealers, setDealers] = useState<DealerOption[]>([]);
  const [minAge, setMinAge] = useState<string>("90");
  const [dealerId, setDealerId] = useState<string>("");
  const [category, setCategory] = useState<string>("");
  const [rows, setRows] = useState<AgeingRow[]>([]);
  const [buckets, setBuckets] = useState<Buckets | null>(null);
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

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (minAge) p.set("minAge", String(Math.max(0, Number(minAge) || 0)));
    if (dealerId) p.set("dealerId", dealerId);
    if (category) p.set("category", category);
    return p.toString();
  }, [minAge, dealerId, category]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/admin/inventory/ageing-report?${queryString}`);
        const json = await res.json();
        if (cancelled) return;
        if (json.success) {
          setRows(json.data.rows || []);
          setBuckets(json.data.buckets || null);
        } else {
          setError(json.error?.message || "Failed to load ageing report");
        }
      } catch {
        if (!cancelled) setError("Failed to load ageing report");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [queryString]);

  const handleDownloadCsv = () => {
    window.location.href = `/api/admin/inventory/ageing-report?${queryString}&format=csv`;
  };

  return (
    <div className="min-h-screen bg-[#F8F9FB]">
      <div className="max-w-[1400px] mx-auto px-6 py-8 space-y-6">
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-[28px] font-black text-gray-900 tracking-tight">
              Inventory Ageing Report
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Stock sitting in dealer warehouses past the threshold. Sold and written-off
              items are excluded.
            </p>
          </div>
          <button
            onClick={handleDownloadCsv}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#0047AB] hover:bg-[#003580] text-white rounded-xl font-bold text-sm transition-colors"
          >
            <Download className="w-4 h-4" /> Download CSV
          </button>
        </header>

        {/* Filters */}
        <section className="bg-white border border-gray-100 rounded-2xl p-5 shadow-sm grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div>
            <label className="block text-[10px] uppercase tracking-wider font-bold text-gray-500 mb-1">
              Min Age (days)
            </label>
            <input
              type="number"
              min={0}
              value={minAge}
              onChange={(e) => setMinAge(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider font-bold text-gray-500 mb-1">
              Dealer
            </label>
            <select
              value={dealerId}
              onChange={(e) => setDealerId(e.target.value)}
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
              Category
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            >
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <span className="text-xs text-gray-500">
              Showing rows with age ≥ <b>{minAge || 0}</b> days.
            </span>
          </div>
        </section>

        {/* Bucket KPIs */}
        {buckets && (
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <KPICard color="emerald" label="0–30 days" value={buckets["0-30"]} />
            <KPICard color="amber" label="31–90 days" value={buckets["31-90"]} />
            <KPICard color="orange" label="91–180 days" value={buckets["91-180"]} />
            <KPICard color="red" label="181+ days" value={buckets["181+"]} />
          </section>
        )}

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Table */}
        <section className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-[#0047AB]" />
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center py-16 text-gray-400 text-sm">
              No ageing inventory matches the current filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500 font-bold">
                  <tr>
                    <th className="px-3 py-3 text-left">Serial</th>
                    <th className="px-3 py-3 text-left">Dealer</th>
                    <th className="px-3 py-3 text-left">Category</th>
                    <th className="px-3 py-3 text-left">Model</th>
                    <th className="px-3 py-3 text-right">Sold Date</th>
                    <th className="px-3 py-3 text-right">Age (d)</th>
                    <th className="px-3 py-3 text-right">Invoice ₹</th>
                    <th className="px-3 py-3 text-left">Status</th>
                    <th className="px-3 py-3 text-left">SOC%</th>
                    <th className="px-3 py-3 text-left">IoT</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((r) => (
                    <tr key={r.battery_id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono">{r.serial_number ?? "—"}</td>
                      <td className="px-3 py-2">{r.dealer_name ?? "—"}</td>
                      <td className="px-3 py-2">{r.category ?? "—"}</td>
                      <td className="px-3 py-2">{r.model_number ?? "—"}</td>
                      <td className="px-3 py-2 text-right">
                        {r.sold_date
                          ? new Date(r.sold_date).toLocaleDateString("en-IN")
                          : "—"}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums font-bold ${ageColor(r.inventory_age_days)}`}>
                        {r.inventory_age_days}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.invoice_value
                          ? `₹${Number(r.invoice_value).toLocaleString("en-IN")}`
                          : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-3 py-2">{r.soc_percent ?? "—"}</td>
                      <td className="px-3 py-2">{r.iot_enabled ? "✓" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function KPICard({
  color,
  label,
  value,
}: {
  color: "emerald" | "amber" | "orange" | "red";
  label: string;
  value: number;
}) {
  const tone: Record<typeof color, string> = {
    emerald: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-700",
    orange: "bg-orange-50 text-orange-700",
    red: "bg-red-50 text-red-700",
  };
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
      <div
        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${tone[color]}`}
      >
        {label}
      </div>
      <p className="text-2xl font-black text-gray-900 mt-2">{value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "available"
      ? "bg-emerald-50 text-emerald-700"
      : status === "reserved"
        ? "bg-amber-50 text-amber-700"
        : status === "transferred_out"
          ? "bg-purple-50 text-purple-700"
          : "bg-gray-100 text-gray-600";
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${cls}`}
    >
      {status}
    </span>
  );
}

function ageColor(d: number): string {
  if (d <= 30) return "text-emerald-700";
  if (d <= 90) return "text-amber-700";
  if (d <= 180) return "text-orange-700";
  return "text-red-700";
}







