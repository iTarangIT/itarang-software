"use client";

// Audit view of a past bulk-upload batch.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  XCircle,
  ListChecks,
  Building2,
  Package,
  UploadCloud,
  User2,
  Clock,
  FileText,
  AlertTriangle,
  Hash,
  Copy,
} from "lucide-react";

interface UploadReport {
  id: string;
  dealerId: string;
  dealerName: string | null;
  inventoryType: string | null;
  assetType: string;
  uploadMethod: string | null;
  uploadedBy: string;
  uploadedByName: string | null;
  uploadedAt: string;
  totalRows: number;
  rowsImported: number;
  rowsSkipped: number;
  errors:
    | { row?: number; field?: string; code?: string; message?: string; error?: string }[]
    | null;
  insertedInventoryIds: string[] | null;
  reportUrl: string | null;
  fileUrl: string | null;
  source: string;
}

export default function UploadReportPage() {
  const { reportId } = useParams() as { reportId: string };
  const [report, setReport] = useState<UploadReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          `/api/admin/inventory/upload-report/${reportId}`,
        );
        const json = await res.json();
        if (json.success) setReport(json.data);
        else setError(json.error?.message || "Failed to load");
      } catch {
        setError("Failed to load");
      } finally {
        setLoading(false);
      }
    })();
  }, [reportId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-50 via-white to-gray-50 flex items-center justify-center">
        <div className="flex items-center gap-3 text-gray-500">
          <div className="w-5 h-5 border-2 border-[#0047AB] border-t-transparent rounded-full animate-spin" />
          <span className="text-sm font-bold">Loading upload report…</span>
        </div>
      </div>
    );
  }
  if (!report) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-50 via-white to-gray-50 flex items-center justify-center px-4">
        <div className="bg-white border border-red-200 rounded-2xl p-6 max-w-md w-full text-center">
          <div className="w-12 h-12 rounded-full bg-red-100 text-red-600 mx-auto flex items-center justify-center mb-3">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <div className="font-black text-gray-900">Report not found</div>
          <div className="text-sm text-gray-500 mt-1">{error || "We couldn't load this upload report."}</div>
          <Link
            href="/admin/inventory"
            className="inline-flex items-center gap-1.5 mt-4 px-4 py-2 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to inventory
          </Link>
        </div>
      </div>
    );
  }

  const errors = report.errors ?? [];
  const insertedIds = report.insertedInventoryIds ?? [];
  const successRate =
    report.totalRows > 0
      ? Math.round((report.rowsImported / report.totalRows) * 100)
      : 0;
  const hasErrors = report.rowsSkipped > 0;

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(report.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 via-white to-gray-50">
      <div className="px-4 sm:px-6 lg:px-8 py-6 sm:py-8 max-w-5xl mx-auto space-y-6">
        {/* Breadcrumb */}
        <Link
          href="/admin/inventory"
          className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-gray-500 hover:text-[#0047AB] transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Inventory
        </Link>

        {/* Hero card */}
        <section
          className={`relative overflow-hidden rounded-3xl border shadow-sm ${
            hasErrors
              ? "bg-gradient-to-br from-amber-50 via-white to-white border-amber-200"
              : "bg-gradient-to-br from-emerald-50 via-white to-white border-emerald-200"
          }`}
        >
          <div className="absolute inset-0 opacity-[0.04] pointer-events-none">
            <div className="absolute -top-12 -right-12 w-64 h-64 rounded-full bg-current" />
          </div>

          <div className="relative p-6 sm:p-8 flex items-start justify-between gap-4 flex-wrap">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-black uppercase tracking-wider ${
                    hasErrors
                      ? "bg-amber-100 border-amber-200 text-amber-800"
                      : "bg-emerald-100 border-emerald-200 text-emerald-800"
                  }`}
                >
                  {hasErrors ? (
                    <AlertTriangle className="w-3 h-3" />
                  ) : (
                    <CheckCircle2 className="w-3 h-3" />
                  )}
                  {hasErrors ? "Partial upload" : "Upload successful"}
                </span>
                <AssetTypeBadge type={report.inventoryType || report.assetType} />
              </div>
              <div>
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 tracking-tight">
                  Upload report
                </h1>
                <button
                  onClick={copyId}
                  className="group inline-flex items-center gap-1.5 mt-1.5 text-xs font-mono text-gray-500 hover:text-[#0047AB] transition-colors"
                  title="Copy report ID"
                >
                  <Hash className="w-3 h-3" />
                  {report.id}
                  <Copy className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                  {copied && (
                    <span className="text-emerald-600 font-bold">Copied!</span>
                  )}
                </button>
              </div>
            </div>

            <Link
              href="/admin/inventory"
              className="inline-flex items-center gap-1.5 px-4 py-2 border border-gray-200 bg-white rounded-xl text-xs font-bold text-gray-700 hover:bg-gray-50 transition-colors shadow-sm"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to inventory
            </Link>
          </div>
        </section>

        {/* Stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
          <StatCard
            label="Total rows"
            value={report.totalRows}
            icon={<ListChecks className="w-4 h-4" />}
            tone="gray"
          />
          <StatCard
            label="Imported"
            value={report.rowsImported}
            total={report.totalRows}
            icon={<CheckCircle2 className="w-4 h-4" />}
            tone="emerald"
          />
          <StatCard
            label="Skipped"
            value={report.rowsSkipped}
            total={report.totalRows}
            icon={<XCircle className="w-4 h-4" />}
            tone={hasErrors ? "red" : "gray"}
          />
        </div>

        {/* Success rate strip */}
        <div className="bg-white border border-gray-100 rounded-2xl p-4 sm:p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="text-[10px] uppercase tracking-wider font-bold text-gray-500">
              Success rate
            </div>
            <div className="text-2xl font-black text-gray-900">{successRate}%</div>
          </div>
          <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
            <div
              className={`h-full rounded-full transition-[width] duration-700 ease-out ${
                successRate === 100
                  ? "bg-gradient-to-r from-emerald-500 to-emerald-400"
                  : successRate >= 50
                    ? "bg-gradient-to-r from-amber-400 to-amber-500"
                    : "bg-gradient-to-r from-red-500 to-red-400"
              }`}
              style={{ width: `${successRate}%` }}
            />
          </div>
        </div>

        {/* Detail grid */}
        <section className="bg-white border border-gray-100 rounded-2xl p-5 sm:p-6 shadow-sm">
          <h2 className="font-black text-gray-900 mb-4">Upload details</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <DetailRow
              icon={<Building2 className="w-4 h-4" />}
              label="Dealer"
              value={report.dealerName || report.dealerId}
              tone="blue"
            />
            <DetailRow
              icon={<Package className="w-4 h-4" />}
              label="Inventory type"
              value={report.inventoryType || report.assetType}
              tone="purple"
            />
            <DetailRow
              icon={<UploadCloud className="w-4 h-4" />}
              label="Upload method"
              value={(report.uploadMethod || report.source || "—").toUpperCase()}
              tone="emerald"
            />
            <DetailRow
              icon={<User2 className="w-4 h-4" />}
              label="Uploaded by"
              value={report.uploadedByName || report.uploadedBy}
              tone="amber"
            />
            <DetailRow
              icon={<Clock className="w-4 h-4" />}
              label="Uploaded at"
              value={new Date(report.uploadedAt).toLocaleString("en-IN", {
                day: "2-digit",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
              tone="gray"
              full
            />
          </div>
        </section>

        {/* Skipped rows */}
        {errors.length > 0 && (
          <section className="bg-white border border-red-100 rounded-2xl shadow-sm overflow-hidden">
            <div className="bg-gradient-to-r from-red-50 to-white px-5 sm:px-6 py-4 border-b border-red-100 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-red-500 text-white flex items-center justify-center">
                  <XCircle className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-black text-red-700">Skipped rows</h2>
                  <p className="text-[11px] text-red-600/80">
                    These rows were not committed — fix and re-upload
                  </p>
                </div>
              </div>
              <span className="inline-flex items-center px-3 py-1 rounded-full bg-red-100 text-red-700 text-xs font-black">
                {errors.length}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50">
                  <tr className="text-left">
                    <th className="px-4 sm:px-6 py-3 font-black text-[10px] uppercase tracking-wider text-gray-500 w-24">
                      Row
                    </th>
                    <th className="px-4 sm:px-6 py-3 font-black text-[10px] uppercase tracking-wider text-gray-500">
                      Error
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {errors.map((e, idx) => (
                    <tr
                      key={idx}
                      className="border-t border-gray-50 hover:bg-red-50/40 transition-colors"
                    >
                      <td className="px-4 sm:px-6 py-3 font-mono text-gray-500">
                        {e.row ?? "—"}
                      </td>
                      <td className="px-4 sm:px-6 py-3">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-red-100 text-red-700 font-medium">
                          {e.message ||
                            e.error ||
                            `${e.field || "row"}: ${e.code || "ERROR"}`}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Inserted items */}
        {insertedIds.length > 0 && (
          <section className="bg-white border border-emerald-100 rounded-2xl shadow-sm overflow-hidden">
            <div className="bg-gradient-to-r from-emerald-50 to-white px-5 sm:px-6 py-4 border-b border-emerald-100 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-emerald-500 text-white flex items-center justify-center">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-black text-emerald-700">Inserted items</h2>
                  <p className="text-[11px] text-emerald-600/80">
                    Click any ID to open the inventory detail
                  </p>
                </div>
              </div>
              <span className="inline-flex items-center px-3 py-1 rounded-full bg-emerald-100 text-emerald-700 text-xs font-black">
                {insertedIds.length}
              </span>
            </div>
            <div className="p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {insertedIds.map((id) => (
                <Link
                  key={id}
                  href={`/admin/inventory/${id}`}
                  className="group flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border border-gray-100 hover:border-emerald-300 hover:bg-emerald-50/40 transition-all"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <FileText className="w-3.5 h-3.5 text-gray-400 group-hover:text-emerald-600 flex-shrink-0" />
                    <span className="font-mono text-xs text-gray-700 group-hover:text-emerald-700 truncate">
                      {id}
                    </span>
                  </div>
                  <ArrowRight className="w-3.5 h-3.5 text-gray-300 group-hover:text-emerald-600 group-hover:translate-x-0.5 transition-all flex-shrink-0" />
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  total,
  tone,
  icon,
}: {
  label: string;
  value: number;
  total?: number;
  tone: "gray" | "emerald" | "red";
  icon: React.ReactNode;
}) {
  const map = {
    gray: {
      wrap: "from-white to-gray-50 border-gray-200",
      number: "text-gray-900",
      iconBg: "bg-gray-100 text-gray-500",
      bar: "from-gray-300 to-gray-400",
    },
    emerald: {
      wrap: "from-emerald-50 to-white border-emerald-200",
      number: "text-emerald-700",
      iconBg: "bg-emerald-100 text-emerald-700",
      bar: "from-emerald-500 to-emerald-400",
    },
    red: {
      wrap: "from-red-50 to-white border-red-200",
      number: "text-red-700",
      iconBg: "bg-red-100 text-red-700",
      bar: "from-red-500 to-red-400",
    },
  }[tone];
  const pct =
    typeof total === "number" && total > 0
      ? Math.min(100, Math.round((value / total) * 100))
      : null;
  return (
    <div className={`bg-gradient-to-br border rounded-2xl p-4 sm:p-5 shadow-sm ${map.wrap}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider font-bold text-gray-500">
          {label}
        </div>
        <div
          className={`w-8 h-8 rounded-lg flex items-center justify-center ${map.iconBg}`}
        >
          {icon}
        </div>
      </div>
      <div className={`text-3xl sm:text-4xl font-black mt-2 ${map.number}`}>
        {value}
      </div>
      {pct !== null && (
        <div className="mt-3 space-y-1">
          <div className="h-1 rounded-full bg-gray-100 overflow-hidden">
            <div
              className={`h-full bg-gradient-to-r transition-[width] duration-700 ease-out ${map.bar}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="text-[10px] font-bold text-gray-500">{pct}% of total</div>
        </div>
      )}
    </div>
  );
}

function DetailRow({
  icon,
  label,
  value,
  tone,
  full,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "blue" | "emerald" | "purple" | "amber" | "gray";
  full?: boolean;
}) {
  const map = {
    blue: "bg-blue-50 text-[#0047AB]",
    emerald: "bg-emerald-50 text-emerald-700",
    purple: "bg-purple-50 text-purple-700",
    amber: "bg-amber-50 text-amber-700",
    gray: "bg-gray-100 text-gray-600",
  }[tone];
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 rounded-xl border border-gray-100 bg-gradient-to-r from-gray-50/50 to-white ${
        full ? "sm:col-span-2" : ""
      }`}
    >
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${map}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wider font-bold text-gray-500">
          {label}
        </div>
        <div className="text-sm font-bold text-gray-900 truncate mt-0.5">{value}</div>
      </div>
    </div>
  );
}

function AssetTypeBadge({ type }: { type: string }) {
  const t = (type || "").toLowerCase();
  const map: Record<string, { label: string; classes: string }> = {
    battery: {
      label: "Battery",
      classes: "bg-blue-50 border-blue-200 text-[#0047AB]",
    },
    charger: {
      label: "Charger",
      classes: "bg-purple-50 border-purple-200 text-purple-700",
    },
    paraphernalia: {
      label: "Paraphernalia",
      classes: "bg-amber-50 border-amber-200 text-amber-700",
    },
  };
  const meta = map[t] || {
    label: type || "—",
    classes: "bg-gray-50 border-gray-200 text-gray-700",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-black uppercase tracking-wider ${meta.classes}`}
    >
      <Package className="w-3 h-3" />
      {meta.label}
    </span>
  );
}
