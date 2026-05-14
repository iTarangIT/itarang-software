"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Plus,
  Phone,
  MapPin,
  Store,
  User,
  TrendingUp,
  Clock,
  RefreshCw,
  AlertCircle,
  Search,
  ChevronLeft,
  ChevronRight,
  Calendar,
  Zap,
  StopCircle,
  PhoneCall,
  Upload,
  X,
  CheckCircle,
  FileSpreadsheet,
  Loader2,
  ChevronDown,
} from "lucide-react";
import { CallButton } from "@/components/leads/call-button";
import { ScraperDashboard } from "@/components/scraper/ScraperDashboard";
import { DownloadConvertedLeadsButton } from "@/components/leads/DownloadButton";
import {
  DialerStartModal,
  type DialerProvider,
  type DialerCategory,
  type DialerStartPayload,
} from "@/components/leads/dialer-start-modal";
import {
  LeadCallStatus,
  type CallRowStatus,
} from "@/components/leads/lead-call-status";

const ENDED_VISIBLE_MS = 8000;
const MANUAL_CALL_MAX_MS = 3 * 60 * 1000;

type Tab = "leads" | "scraper" | "converted";
type DialerPhase = "idle" | "calling" | "countdown";
type UploadStatus = "idle" | "parsing" | "uploading" | "done" | "error";

const SALES_MANAGERS = ["SM1", "SM2", "SM3", "SM4"];

const STATUS_CONFIG: Record<
  string,
  { label: string; bg: string; text: string; dot: string }
> = {
  hot: {
    label: "Hot",
    bg: "bg-red-50",
    text: "text-red-600",
    dot: "bg-red-500",
  },
  warm: {
    label: "Warm",
    bg: "bg-amber-50",
    text: "text-amber-600",
    dot: "bg-amber-400",
  },
  cold: {
    label: "Cold",
    bg: "bg-blue-50",
    text: "text-blue-600",
    dot: "bg-blue-400",
  },
  new: {
    label: "New",
    bg: "bg-gray-100",
    text: "text-gray-600",
    dot: "bg-gray-400",
  },
  qualified: {
    label: "Qualified",
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    dot: "bg-emerald-500",
  },
  disqualified: {
    label: "Disqualified",
    bg: "bg-zinc-100",
    text: "text-zinc-500",
    dot: "bg-zinc-400",
  },
  callback_requested: {
    label: "Callback",
    bg: "bg-purple-50",
    text: "text-purple-600",
    dot: "bg-purple-500",
  },
  stop: {
    label: "Stop",
    bg: "bg-red-100",
    text: "text-red-700",
    dot: "bg-red-600",
  },
  completed: {
    label: "Completed",
    bg: "bg-teal-50",
    text: "text-teal-700",
    dot: "bg-teal-500",
  },
  converted: {
    label: "Converted",
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    dot: "bg-emerald-500",
  },
  pending: {
    label: "Pending",
    bg: "bg-gray-100",
    text: "text-gray-600",
    dot: "bg-gray-400",
  },
  assigned: {
    label: "Assigned",
    bg: "bg-blue-50",
    text: "text-blue-600",
    dot: "bg-blue-400",
  },
};

const OUTCOME_CONFIG: Record<string, { label: string; color: string }> = {
  callback_requested: { label: "Callback Requested", color: "text-purple-600" },
  interested: { label: "Interested", color: "text-emerald-600" },
  disqualified: { label: "Not Interested", color: "text-red-500" },
  unknown: { label: "No Outcome", color: "text-gray-400" },
  completed: { label: "Completed", color: "text-teal-600" },
};

const NO_CALL_STATUSES = ["stop", "completed", "dnc", "failed"];
const COUNTDOWN_SECS = 10;

// ─── Helpers ──────────────────────────────────────────────────

function getStatusConfig(status: string | null) {
  return (
    STATUS_CONFIG[status ?? "new"] ?? {
      label: status ?? "New",
      bg: "bg-gray-100",
      text: "text-gray-600",
      dot: "bg-gray-400",
    }
  );
}
function getIntentColor(score: number | null) {
  if (!score) return "text-gray-400";
  if (score >= 75) return "text-emerald-600";
  if (score >= 50) return "text-amber-500";
  return "text-red-500";
}
function getIntentBg(score: number | null) {
  if (!score) return "bg-gray-100";
  if (score >= 75) return "bg-emerald-50";
  if (score >= 50) return "bg-amber-50";
  return "bg-red-50";
}
function formatNextCall(date: string | null) {
  if (!date) return null;
  const now = new Date();
  const diff = new Date(date).getTime() - now.getTime();
  if (diff < 0) return "Overdue";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  return `in ${Math.floor(hrs / 24)}d`;
}
function getLastOutcome(history: any[]): string | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  return history[history.length - 1]?.outcome ?? null;
}
function formatDate(date: string | null) {
  if (!date) return "-";
  return new Date(date).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
function isCalledToday(lead: any): boolean {
  const history: any[] = lead.follow_up_history ?? [];
  if (history.length === 0) return false;
  const last = history[history.length - 1];
  if (!last?.called_at) return false;
  const today = new Date();
  const lastCall = new Date(last.called_at);
  return (
    lastCall.getFullYear() === today.getFullYear() &&
    lastCall.getMonth() === today.getMonth() &&
    lastCall.getDate() === today.getDate()
  );
}
function buildDialerQueue(leads: any[]): any[] {
  return [...leads]
    .filter((l) => {
      if (!l.phone || l.phone.trim() === "") return false;
      if (NO_CALL_STATUSES.includes(l.current_status ?? "")) return false;
      if (isCalledToday(l)) return false;
      return true;
    })
    .sort((a, b) => (b.final_intent_score ?? 0) - (a.final_intent_score ?? 0));
}

// ─── CSV Parser ───────────────────────────────────────────────

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0]
    .split(",")
    .map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());
  return lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = values[i] ?? "";
    });
    return row;
  });
}
function normalizeRow(row: Record<string, string>) {
  // Build a lowercase-keyed version of the row for case-insensitive matching
  const lowerRow: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    lowerRow[k.toLowerCase().trim()] = v;
  }
  const get = (...keys: string[]) => {
    for (const k of keys) {
      if (lowerRow[k] !== undefined && lowerRow[k] !== "") return lowerRow[k];
    }
    return null;
  };
  return {
    shop_name: get(
      "shop_name",
      "shop name",
      "shopname",
      "business",
      "business name",
      "store",
      "store name",
      "company/dealer name",
      "company name",
      "company",
    ),
    dealer_name: get(
      "dealer_name",
      "dealer name",
      "dealername",
      "name",
      "owner",
      "owner name",
      "contact",
      "contact person",
    ),
    phone: get(
      "phone",
      "mobile",
      "phone number",
      "mobile number",
      "contact number",
      "number",
    ),
    // `location` stays for backwards compat with single-cell CSVs and is
    // forwarded as the legacy dealer_leads.location text. The structured
    // fields below feed the new region selector.
    location: get("location", "city", "area", "address", "place"),
    state: get("state", "province", "region"),
    city: get("city", "town"),
    area: get("area", "locality", "neighborhood"),
    pincode: get("pincode", "pin", "postal_code", "zip", "zipcode"),
    language: get("language", "lang") ?? "hindi",
    current_status: get("status", "current_status", "lead status") ?? "new",
  };
}

// ─── Upload Modal ─────────────────────────────────────────────

function UploadModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any[]>([]);
  const [result, setResult] = useState<{
    inserted: number;
    skipped: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (f: File) => {
    setFile(f);
    setStatus("parsing");
    setError(null);
    try {
      let rows: Record<string, string>[] = [];
      if (f.name.endsWith(".csv")) {
        const text = await f.text();
        rows = parseCSV(text);
      } else {
        const XLSX = await import("xlsx");
        const buffer = await f.arrayBuffer();
        const wb = XLSX.read(buffer, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
      }
      const normalized = rows.map(normalizeRow).filter((r) => r.phone);
      setPreview(normalized.slice(0, 5));
      setStatus("idle");
      if (normalized.length === 0) {
        setError(
          "No valid rows found. Make sure your file has a 'phone' column.",
        );
        return;
      }
      (window as any).__uploadRows = normalized;
    } catch (e: any) {
      setError("Failed to parse file: " + e.message);
      setStatus("error");
    }
  };

  const handleUpload = async () => {
    const rows = (window as any).__uploadRows;
    if (!rows || rows.length === 0) return;
    setStatus("uploading");
    setError(null);
    try {
      const res = await fetch("/api/leads/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leads: rows }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || "Import failed");
        setStatus("error");
        return;
      }
      setResult({ inserted: data.inserted, skipped: data.skipped });
      setStatus("done");
      delete (window as any).__uploadRows;
    } catch (e: any) {
      setError(e.message);
      setStatus("error");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gray-900 rounded-lg flex items-center justify-center">
              <FileSpreadsheet className="w-4 h-4 text-white" />
            </div>
            <h2 className="text-sm font-semibold text-gray-900">
              Import Leads
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          {status === "done" && result && (
            <div className="text-center py-6">
              <div className="w-12 h-12 bg-emerald-50 rounded-2xl flex items-center justify-center mx-auto mb-3">
                <CheckCircle className="w-6 h-6 text-emerald-600" />
              </div>
              <p className="text-base font-semibold text-gray-900 mb-1">
                Import Complete
              </p>
              <p className="text-sm text-gray-500">
                <span className="text-emerald-600 font-medium">
                  {result.inserted} leads added
                </span>
                {result.skipped > 0 && (
                  <span className="text-gray-400">
                    {" "}
                    · {result.skipped} skipped (duplicate phone)
                  </span>
                )}
              </p>
              <button
                onClick={() => {
                  onSuccess();
                  onClose();
                }}
                className="mt-4 px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-700 transition-colors"
              >
                Done
              </button>
            </div>
          )}
          {status !== "done" && (
            <>
              <div
                onClick={() => fileRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${file ? "border-gray-300 bg-gray-50" : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"}`}
              >
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                  }}
                />
                {file ? (
                  <div className="flex items-center justify-center gap-2">
                    <FileSpreadsheet className="w-5 h-5 text-gray-600" />
                    <span className="text-sm font-medium text-gray-700">
                      {file.name}
                    </span>
                  </div>
                ) : (
                  <>
                    <Upload className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                    <p className="text-sm font-medium text-gray-600">
                      Click to upload CSV or Excel
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      .csv, .xlsx, .xls supported
                    </p>
                  </>
                )}
              </div>
              {!file && (
                <div className="bg-gray-50 rounded-xl p-4">
                  <p className="text-xs font-medium text-gray-600 mb-2">
                    Expected columns
                  </p>
                  <div className="grid grid-cols-2 gap-1">
                    {[
                      { col: "phone", req: true },
                      { col: "dealer_name / name", req: false },
                      { col: "shop_name", req: false },
                      { col: "location / city", req: false },
                    ].map(({ col, req }) => (
                      <div
                        key={col}
                        className="flex items-center gap-1.5 text-xs text-gray-500"
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${req ? "bg-red-400" : "bg-gray-300"}`}
                        />
                        {col}
                        {req && (
                          <span className="text-red-400 text-[10px]">
                            required
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {preview.length > 0 && status !== "uploading" && (
                <div>
                  <p className="text-xs font-medium text-gray-600 mb-2">
                    Preview — first {preview.length} rows
                    <span className="text-gray-400 font-normal ml-1">
                      ({(window as any).__uploadRows?.length ?? 0} total)
                    </span>
                  </p>
                  <div className="border rounded-xl overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 border-b">
                        <tr>
                          {[
                            "shop_name",
                            "dealer_name",
                            "phone",
                            "location",
                          ].map((h) => (
                            <th
                              key={h}
                              className="px-3 py-2 text-left font-medium text-gray-500"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {preview.map((row, i) => (
                          <tr key={i}>
                            <td className="px-3 py-2 text-gray-700 truncate max-w-[100px]">
                              {row.shop_name || "—"}
                            </td>
                            <td className="px-3 py-2 text-gray-700 truncate max-w-[100px]">
                              {row.dealer_name || "—"}
                            </td>
                            <td className="px-3 py-2 text-gray-700">
                              {row.phone}
                            </td>
                            <td className="px-3 py-2 text-gray-500">
                              {row.location || "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {error && (
                <div className="flex items-start gap-2 bg-red-50 border border-red-100 rounded-xl p-3">
                  <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-600">{error}</p>
                </div>
              )}
              {file && preview.length > 0 && status !== "uploading" && (
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setFile(null);
                      setPreview([]);
                      setError(null);
                      delete (window as any).__uploadRows;
                      if (fileRef.current) fileRef.current.value = "";
                    }}
                    className="flex-1 px-4 py-2 text-sm font-medium border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    Change file
                  </button>
                  <button
                    onClick={handleUpload}
                    className="flex-1 px-4 py-2 text-sm font-medium bg-gray-900 text-white rounded-lg hover:bg-gray-700 transition-colors"
                  >
                    Import {(window as any).__uploadRows?.length ?? 0} leads
                  </button>
                </div>
              )}
              {status === "uploading" && (
                <div className="flex items-center justify-center gap-2 py-4 text-gray-500">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">Importing leads...</span>
                </div>
              )}
              {status === "parsing" && (
                <div className="flex items-center justify-center gap-2 py-4 text-gray-500">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">Parsing file...</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Pagination ───────────────────────────────────────────────

function Pagination({
  page,
  total,
  limit,
  onChange,
}: {
  page: number;
  total: number;
  limit: number;
  onChange: (p: number) => void;
}) {
  const totalPages = Math.ceil(total / limit);
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-1 mt-4">
      <p className="text-xs text-gray-400">
        Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of{" "}
        {total}
      </p>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onChange(page - 1)}
          disabled={page === 1}
          className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
          const p =
            totalPages <= 5
              ? i + 1
              : page <= 3
                ? i + 1
                : page >= totalPages - 2
                  ? totalPages - 4 + i
                  : page - 2 + i;
          return (
            <button
              key={p}
              onClick={() => onChange(p)}
              className={`w-8 h-8 rounded-lg text-xs font-medium transition-all ${p === page ? "bg-gray-900 text-white" : "border border-gray-200 text-gray-600 hover:bg-gray-50"}`}
            >
              {p}
            </button>
          );
        })}
        <button
          onClick={() => onChange(page + 1)}
          disabled={page === totalPages}
          className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ─── AI Dialer Banner ─────────────────────────────────────────

function AiDialerBanner({
  phase,
  currentLead,
  nextLead,
  countdown,
  callsMade,
  totalEligible,
  onStop,
  onSkipCountdown,
  provider,
}: {
  phase: DialerPhase;
  currentLead: any | null;
  nextLead: any | null;
  countdown: number;
  callsMade: number;
  totalEligible: number;
  onStop: () => void;
  onSkipCountdown: () => void;
  provider: DialerProvider;
}) {
  const providerLabel = provider === "elevenlabs" ? "ElevenLabs" : "Bolna";
  const providerChip =
    provider === "elevenlabs"
      ? "bg-violet-500/20 text-violet-300 border-violet-500/40"
      : "bg-blue-500/20 text-blue-300 border-blue-500/40";
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl px-5 py-4 mb-4 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div
          className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-colors ${phase === "calling" ? "bg-emerald-500" : "bg-amber-500"}`}
        >
          {phase === "calling" ? (
            <PhoneCall className="w-4 h-4 text-white animate-pulse" />
          ) : (
            <Clock className="w-4 h-4 text-white" />
          )}
        </div>
        <div className="min-w-0">
          {phase === "calling" && currentLead && (
            <>
              <p className="text-sm font-semibold text-white truncate flex items-center gap-2">
                Calling —{" "}
                {currentLead.shop_name || currentLead.dealer_name || "Lead"}
                <span
                  className={`px-2 py-0.5 text-[10px] font-semibold rounded border ${providerChip}`}
                >
                  {providerLabel}
                </span>
              </p>
              <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-2 flex-wrap">
                <span className="flex items-center gap-1">
                  <Phone className="w-3 h-3" />
                  {currentLead.phone}
                </span>
                {currentLead.final_intent_score != null && (
                  <span className="flex items-center gap-1 text-emerald-400">
                    <TrendingUp className="w-3 h-3" /> Score{" "}
                    {currentLead.final_intent_score}
                  </span>
                )}
              </p>
            </>
          )}
          {phase === "countdown" && (
            <>
              <p className="text-sm font-semibold text-white">
                Next call in{" "}
                <span className="text-amber-400 tabular-nums">
                  {countdown}s
                </span>
              </p>
              {nextLead && (
                <p className="text-xs text-gray-400 mt-0.5 truncate">
                  Up next:{" "}
                  {nextLead.shop_name || nextLead.dealer_name || "Lead"}
                  {nextLead.final_intent_score != null &&
                    ` · Score ${nextLead.final_intent_score}`}
                </p>
              )}
            </>
          )}
        </div>
      </div>
      <div className="hidden md:flex flex-col items-center gap-1.5 shrink-0">
        <p className="text-xs text-gray-400 tabular-nums">
          {callsMade} / {totalEligible} calls
        </p>
        <div className="w-36 h-1.5 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500 rounded-full transition-all duration-500"
            style={{
              width:
                totalEligible > 0
                  ? `${(callsMade / totalEligible) * 100}%`
                  : "0%",
            }}
          />
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {phase === "countdown" && (
          <button
            onClick={onSkipCountdown}
            className="px-3 py-1.5 text-xs font-medium bg-amber-500 hover:bg-amber-600 text-white rounded-lg transition-all"
          >
            Call Now
          </button>
        )}
        <button
          onClick={onStop}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-500 hover:bg-red-600 text-white rounded-lg transition-all"
        >
          <StopCircle className="w-3.5 h-3.5" /> Stop
        </button>
      </div>
    </div>
  );
}

// ─── Converted Lead Card ──────────────────────────────────────

function ConvertedLeadCard({
  lead,
  onUpdate,
}: {
  lead: any;
  onUpdate: () => void;
}) {
  const [assigning, setAssigning] = useState(false);
  const [saving, setSaving] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const statusCfg = getStatusConfig(lead.current_status);
  const intentScore = lead.final_intent_score;

  useEffect(() => {
    if (!assigning) return;
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setAssigning(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [assigning]);

  const handleAssign = async (manager: string) => {
    setSaving(true);
    try {
      await fetch("/api/dealer-leads/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId: lead.id,
          action: "assign",
          assignTo: manager,
        }),
      });
      onUpdate();
    } finally {
      setSaving(false);
      setAssigning(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 py-4 hover:border-gray-300 hover:shadow-sm transition-all duration-150">
      <div className="flex items-center justify-between gap-4">
        {/* LEFT */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center shrink-0">
            <Store className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate">
              {lead.shop_name || "Unnamed Shop"}
            </p>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <span className="flex items-center gap-1 text-xs text-gray-500">
                <User className="w-3 h-3" />
                {lead.dealer_name || "Unknown"}
              </span>
              <span className="text-gray-300">·</span>
              <span className="flex items-center gap-1 text-xs text-gray-400">
                <MapPin className="w-3 h-3" />
                {lead.location || "-"}
              </span>
              <span className="text-gray-300">·</span>
              <span className="flex items-center gap-1 text-xs text-gray-400">
                <Phone className="w-3 h-3" />
                {lead.phone || "-"}
              </span>
              <span className="text-gray-300">·</span>
              <span className="flex items-center gap-1 text-xs text-gray-400">
                <Calendar className="w-3 h-3" />
                {formatDate(lead.created_at)}
              </span>
            </div>
          </div>
        </div>

        {/* RIGHT */}
        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          <span
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${statusCfg.bg} ${statusCfg.text}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${statusCfg.dot}`} />
            {statusCfg.label}
          </span>

          {intentScore != null && (
            <span
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${getIntentBg(intentScore)} ${getIntentColor(intentScore)}`}
            >
              <TrendingUp className="w-3 h-3" />
              {intentScore}
            </span>
          )}

          {lead.assigned_to && (
            <span className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-600">
              <User className="w-3 h-3" />
              {lead.assigned_to}
            </span>
          )}

          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setAssigning((v) => !v)}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-gray-200 rounded-lg hover:bg-gray-50 transition-all disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <User className="w-3 h-3" />
              )}
              {lead.assigned_to ? "Reassign" : "Assign to Sales Head"}
              <ChevronDown
                className={`w-3 h-3 text-gray-400 transition-transform ${assigning ? "rotate-180" : ""}`}
              />
            </button>

            {assigning && (
              <div className="absolute right-0 top-full mt-1 w-48 bg-white border border-gray-200 rounded-xl shadow-lg z-20 overflow-hidden">
                <div className="px-3 py-2 border-b">
                  <p className="text-xs font-medium text-gray-500">
                    Select Sales Manager
                  </p>
                </div>
                <div className="py-1">
                  {SALES_MANAGERS.map((manager) => (
                    <button
                      key={manager}
                      onClick={() => handleAssign(manager)}
                      className={`w-full text-left px-3 py-2 text-xs hover:bg-gray-50 transition-colors flex items-center justify-between ${lead.assigned_to === manager ? "text-blue-600 font-medium" : "text-gray-700"}`}
                    >
                      {manager}
                      {lead.assigned_to === manager && (
                        <CheckCircle className="w-3 h-3 text-blue-500" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <Link href={`/leads/${lead.id}`}>
            <button className="px-3 py-1.5 text-xs font-medium border border-gray-200 rounded-lg hover:bg-gray-50 transition-all">
              View
            </button>
          </Link>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────

export default function LeadsUnifiedPage() {
  const searchParams = useSearchParams();
  // Honor `?tab=scraper` (or `?tab=converted`) on first render so the back
  // button from /leads/scrape-runs/[id] lands on the Scraper tab the user
  // came from, not the default Leads tab.
  const initialTab: Tab = (() => {
    const t = searchParams?.get("tab");
    return t === "scraper" || t === "converted" ? t : "leads";
  })();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [search, setSearch] = useState("");
  const [showUpload, setShowUpload] = useState(false);

  const [leads, setLeads] = useState<any[]>([]);
  const [leadsTotal, setLeadsTotal] = useState(0);
  const [leadsPage, setLeadsPage] = useState(1);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [leadsError, setLeadsError] = useState<string | null>(null);

  const [convertedLeads, setConvertedLeads] = useState<any[]>([]);
  const [convertedTotal, setConvertedTotal] = useState(0);
  const [convertedPage, setConvertedPage] = useState(1);
  const [convertedLoading, setConvertedLoading] = useState(false);

  const [dialerOn, setDialerOn] = useState(false);
  const [dialerPhase, setDialerPhase] = useState<DialerPhase>("idle");
  const [dialerQueue, setDialerQueue] = useState<any[]>([]);
  const [dialerIndex, setDialerIndex] = useState(0);
  const [dialerModalOpen, setDialerModalOpen] = useState(false);
  const [dialerProvider, setDialerProvider] = useState<DialerProvider>("bolna");

  // Per-row call status (live indicator on each lead)
  const [callingLeadId, setCallingLeadId] = useState<string | null>(null);
  const [callingLeadStartedAt, setCallingLeadStartedAt] = useState<number>(0);
  const [endedLeadIds, setEndedLeadIds] = useState<Map<string, number>>(
    new Map(),
  );

  const markEnded = useCallback((leadId: string) => {
    setEndedLeadIds((prev) => {
      const next = new Map(prev);
      next.set(leadId, Date.now() + ENDED_VISIBLE_MS);
      return next;
    });
  }, []);

  const startCallingLead = useCallback(
    (leadId: string) => {
      setCallingLeadId((prev) => {
        if (prev && prev !== leadId) markEnded(prev);
        return leadId;
      });
      setCallingLeadStartedAt(Date.now());
    },
    [markEnded],
  );

  // Prune expired entries: remove "ended" pills after their TTL, and clear
  // any optimistic "calling" state that's been stuck too long (e.g. manual
  // call where the user navigated away or the call was never picked up).
  useEffect(() => {
    const tick = setInterval(() => {
      const now = Date.now();
      setEndedLeadIds((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [id, expiresAt] of next) {
          if (expiresAt <= now) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      if (
        callingLeadId &&
        callingLeadStartedAt > 0 &&
        now - callingLeadStartedAt > MANUAL_CALL_MAX_MS
      ) {
        setCallingLeadId(null);
        setCallingLeadStartedAt(0);
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [callingLeadId, callingLeadStartedAt]);

  const getRowStatus = useCallback(
    (leadId: string): CallRowStatus => {
      if (callingLeadId === leadId) return "calling";
      if (endedLeadIds.has(leadId)) return "ended";
      return "idle";
    },
    [callingLeadId, endedLeadIds],
  );
  const [dialerCallsMade, setDialerCallsMade] = useState(0);
  const [countdown, setCountdown] = useState(COUNTDOWN_SECS);

  const countdownRef = useRef<NodeJS.Timeout | null>(null);
  const pollerRef = useRef<NodeJS.Timeout | null>(null);
  const stopRef = useRef(false);
  const queueRef = useRef<any[]>([]);
  const indexRef = useRef(0);

  const LIMIT = 10;

  const fetchLeads = useCallback(async (page: number, q: string) => {
    setLeadsLoading(true);
    try {
      const res = await fetch(
        `/api/dealer-leads?page=${page}&limit=${LIMIT}&search=${encodeURIComponent(q)}`,
      );
      const data = await res.json();
      if (data.success) {
        setLeads(data.leads);
        setLeadsTotal(data.total);
        setLeadsError(null);
      } else {
        // Surface API failures instead of rendering a silent empty state.
        // Most commonly this fires when schema.ts and the live DB drift —
        // e.g. a new E-NNN migration hasn't been applied to the host the
        // dev server connects to (check the [DB] log on server start).
        console.error("[leads] /api/dealer-leads failed:", data);
        setLeads([]);
        setLeadsTotal(0);
        setLeadsError(data.error?.message ?? data.error ?? "Failed to load leads");
      }
    } catch (err: any) {
      console.error("[leads] /api/dealer-leads network error:", err);
      setLeads([]);
      setLeadsTotal(0);
      setLeadsError(err?.message ?? "Network error loading leads");
    } finally {
      setLeadsLoading(false);
    }
  }, []);

  const fetchConvertedLeads = useCallback(async (page: number, q: string) => {
    setConvertedLoading(true);
    try {
      const res = await fetch(
        `/api/scraper-leads/converted?page=${page}&limit=${LIMIT}&search=${encodeURIComponent(q)}`,
      );
      const data = await res.json();
      if (data.success) {
        setConvertedLeads(data.leads);
        setConvertedTotal(data.total);
      }
    } finally {
      setConvertedLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "leads") fetchLeads(leadsPage, search);
    if (tab === "converted") fetchConvertedLeads(convertedPage, search);
  }, [tab, leadsPage, convertedPage, search]);

  const handleSearch = (v: string) => {
    setSearch(v);
    setLeadsPage(1);
    setConvertedPage(1);
  };

  const triggerCall = useCallback(
    async (lead: any) => {
      setDialerPhase("calling");
      const endpoint =
        dialerProvider === "elevenlabs"
          ? "/api/elevenlabs/call"
          : "/api/bolna/call";
      try {
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: lead.phone, leadId: lead.id }),
        });
      } catch (e) {
        console.error("Dialer call error", e);
      }
    },
    [dialerProvider],
  );

  const startCountdownTo = useCallback(
    (nextIdx: number) => {
      const queue = queueRef.current;
      if (stopRef.current || nextIdx >= queue.length) {
        setDialerPhase("idle");
        setDialerOn(false);
        return;
      }
      setDialerPhase("countdown");
      setDialerIndex(nextIdx);
      indexRef.current = nextIdx;
      setCountdown(COUNTDOWN_SECS);
      let secs = COUNTDOWN_SECS;
      if (countdownRef.current) clearInterval(countdownRef.current);
      countdownRef.current = setInterval(() => {
        secs -= 1;
        setCountdown(secs);
        if (secs <= 0) {
          clearInterval(countdownRef.current!);
          if (stopRef.current) return;
          const idx = indexRef.current;
          triggerCall(queueRef.current[idx]).then(() => {
            setDialerCallsMade((c) => c + 1);
            startCountdownTo(idx + 1);
          });
        }
      }, 1000);
    },
    [triggerCall],
  );

  const startDialerPoller = useCallback(() => {
    if (pollerRef.current) clearInterval(pollerRef.current);
    pollerRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/ai-dialer/status");
        const status = await res.json();
        if (!status.active) {
          // Session ended on the backend — queue exhausted
          if (pollerRef.current) clearInterval(pollerRef.current);
          setDialerOn(false);
          setDialerPhase("idle");
          return;
        }
        if (status.provider && status.provider !== dialerProvider) {
          setDialerProvider(status.provider as DialerProvider);
        }
        setDialerCallsMade(status.callsMade);
        // Track per-row calling status: if currentLeadId changed, transition
        // the previous one into "ended" and mark the new one as calling.
        if (status.currentLeadId && status.currentLeadId !== callingLeadId) {
          startCallingLead(status.currentLeadId);
        }
        // Find the index of the current lead in our local queue
        const idx = queueRef.current.findIndex(
          (l: any) => l.id === status.currentLeadId,
        );
        if (idx >= 0 && idx !== indexRef.current) {
          setDialerIndex(idx);
          indexRef.current = idx;
          setDialerPhase("calling");
        }
      } catch {
        // ignore poll errors
      }
    }, 2000);
  }, [dialerProvider, callingLeadId, startCallingLead]);

  // Click on the toggle (when off): open the region/segment picker. We
  // no longer pre-fetch the full lead list — /api/ai-dialer/preview
  // serves the modal's live counts and returns the queue (id + phone)
  // server-side, so the picker scales to lead sets larger than 500.
  const handleDialerOn = useCallback(() => {
    setDialerModalOpen(true);
  }, []);

  // Modal confirmed → persist the chosen provider in the dialer session,
  // tag dealer_leads, and fire the first call via the chosen provider's
  // endpoint. Subsequent calls advance via each provider's webhook
  // (advanceDialerToNextLead). The modal already filtered the queue by
  // region + segment server-side, so we use it directly.
  const confirmDialerStart = useCallback(
    async ({ provider, category, region, queue }: DialerStartPayload) => {
      if (queue.length === 0) return;

      stopRef.current = false;
      queueRef.current = queue;
      setDialerQueue(queue);
      setDialerIndex(0);
      setDialerCallsMade(0);
      setDialerProvider(provider);
      setDialerOn(true);
      setDialerPhase("calling");

      await fetch("/api/ai-dialer/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queueIds: queue.map((l) => l.id),
          provider,
          category,
          // Audit/telemetry only — the server still trusts queueIds as
          // the authoritative list. See /api/ai-dialer/start/route.ts.
          region,
        }),
      });

      const callEndpoint =
        provider === "elevenlabs" ? "/api/elevenlabs/call" : "/api/bolna/call";
      const head = queue[0];
      // Optimistically light up the row before the network round-trip so
      // the user sees instant feedback on the lead card.
      startCallingLead(head.id);
      await fetch(callEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: head.phone, leadId: head.id }),
      });

      setDialerCallsMade(1);
      startDialerPoller();
    },
    [startDialerPoller, startCallingLead],
  );

  const handleDialerOff = useCallback(() => {
    stopRef.current = true;
    if (countdownRef.current) clearInterval(countdownRef.current);
    if (pollerRef.current) clearInterval(pollerRef.current);
    setDialerOn(false);
    setDialerPhase("idle");
    setDialerQueue([]);
    setDialerIndex(0);
    setDialerCallsMade(0);
    if (callingLeadId) markEnded(callingLeadId);
    setCallingLeadId(null);
    setCallingLeadStartedAt(0);
    fetch("/api/ai-dialer/stop", { method: "POST" });
  }, [callingLeadId, markEnded]);

  const handleSkipCountdown = useCallback(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    if (stopRef.current) return;
    const idx = indexRef.current;
    if (idx >= queueRef.current.length) return;
    triggerCall(queueRef.current[idx]).then(() => {
      setDialerCallsMade((c) => c + 1);
      startCountdownTo(idx + 1);
    });
  }, [triggerCall, startCountdownTo]);

  useEffect(
    () => () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (pollerRef.current) clearInterval(pollerRef.current);
    },
    [],
  );

  const stats = {
    total: leadsTotal,
    hot: leads.filter((l) => l.current_status === "hot").length,
    warm: leads.filter((l) => l.current_status === "warm").length,
    qualified: leads.filter((l) => l.current_status === "qualified").length,
    scheduled: leads.filter((l) => l.next_call_at).length,
  };

  const currentDialerLead = dialerQueue[dialerIndex] ?? null;
  const nextDialerLead = dialerQueue[dialerIndex + 1] ?? null;

  return (
    <div className="max-w-6xl mx-auto py-8 px-6 min-h-screen bg-gray-50">
      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onSuccess={() => fetchLeads(1, search)}
        />
      )}

      <DialerStartModal
        isOpen={dialerModalOpen}
        onClose={() => setDialerModalOpen(false)}
        onConfirm={confirmDialerStart}
      />

      {/* HEADER */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
            Leads
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Manage dealer leads and track their interest
          </p>
        </div>
        <div className="flex items-center gap-3">
          {tab === "leads" && (
            <button
              onClick={dialerOn ? handleDialerOff : handleDialerOn}
              className="flex items-center gap-3 px-4 py-2.5 bg-white border border-gray-200 rounded-xl hover:border-gray-300 transition-all shadow-sm cursor-pointer"
            >
              <div
                className={`relative w-9 h-5 rounded-full transition-colors duration-300 ${dialerOn ? "bg-emerald-500" : "bg-gray-200"}`}
              >
                <div
                  className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-300 ${dialerOn ? "translate-x-4" : "translate-x-0"}`}
                />
              </div>
              <span className="flex items-center gap-1.5 text-sm font-medium text-gray-700">
                <Zap
                  className={`w-3.5 h-3.5 transition-colors ${dialerOn ? "text-emerald-500" : "text-gray-400"}`}
                />
                AI Dialer
              </span>
              <span
                className={`text-xs font-medium px-2 py-0.5 rounded-full transition-colors ${dialerOn ? "bg-emerald-50 text-emerald-600" : "bg-gray-100 text-gray-400"}`}
              >
                {dialerOn ? "ON" : "OFF"}
              </span>
            </button>
          )}
          {tab === "leads" && (
            <button
              onClick={() => setShowUpload(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-xl hover:border-gray-300 hover:bg-gray-50 transition-all shadow-sm"
            >
              <Upload className="w-4 h-4" /> Import
            </button>
          )}
          {/* ── Download button shown only on Converted tab ── */}
          {tab === "converted" && <DownloadConvertedLeadsButton />}
          <Link href="/leads/new">
            <button className="flex items-center gap-2 px-4 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-700 transition-all">
              <Plus className="w-4 h-4" /> New Lead
            </button>
          </Link>
        </div>
      </div>

      {/* STATS ROW */}
      {tab === "leads" && (
        <div className="grid grid-cols-5 gap-3 mb-6">
          {[
            { label: "Total Leads", value: leadsTotal, color: "text-gray-900" },
            { label: "Hot", value: stats.hot, color: "text-red-600" },
            { label: "Warm", value: stats.warm, color: "text-amber-600" },
            {
              label: "Qualified",
              value: stats.qualified,
              color: "text-emerald-600",
            },
            {
              label: "Scheduled",
              value: stats.scheduled,
              color: "text-purple-600",
            },
          ].map(({ label, value, color }) => (
            <div
              key={label}
              className="bg-white border border-gray-200 rounded-xl p-4"
            >
              <p className="text-xs text-gray-500 mb-1">{label}</p>
              <p className={`text-2xl font-bold ${color}`}>{value}</p>
            </div>
          ))}
        </div>
      )}

      {/* TABS + SEARCH */}
      <div className="flex items-center justify-between mb-4 gap-4">
        <div className="flex items-center bg-white border border-gray-200 rounded-xl p-1 gap-1">
          {(
            [
              { key: "scraper", label: "Scraper" },
              { key: "leads", label: "Leads" },
              { key: "converted", label: "My Converted Leads" },
            ] as { key: Tab; label: string }[]
          ).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => {
                setTab(key);
              }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${tab === key ? "bg-gray-900 text-white shadow-sm" : "text-gray-500 hover:text-gray-800"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab !== "scraper" && (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search by name, phone, city..."
              className="pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-xl bg-white outline-none focus:border-gray-400 w-64"
            />
          </div>
        )}
      </div>

      {/* ── TAB: SCRAPER ── */}
      {tab === "scraper" && (
        <div>
          <ScraperDashboard />
        </div>
      )}

      {/* ── TAB: LEADS ── */}
      {tab === "leads" && (
        <div>
          {dialerOn && dialerPhase !== "idle" && (
            <AiDialerBanner
              phase={dialerPhase}
              currentLead={currentDialerLead}
              nextLead={nextDialerLead}
              countdown={countdown}
              callsMade={dialerCallsMade}
              totalEligible={dialerQueue.length}
              onStop={handleDialerOff}
              onSkipCountdown={handleSkipCountdown}
              provider={dialerProvider}
            />
          )}
          {leadsError && !leadsLoading && (
            <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              <div className="font-semibold mb-0.5">
                Couldn&apos;t load leads
              </div>
              <div className="text-[12px] text-rose-700 break-all">
                {leadsError}
              </div>
              <div className="text-[11px] text-rose-600 mt-2">
                If this says &quot;column … does not exist&quot;, a pending
                migration (e.g. <code>drizzle/E-106_*</code>) hasn&apos;t been
                applied to the DB this dev server connects to. Check the
                <code> [DB] connected to …</code> line in the server log to
                see which host needs the migration.
              </div>
            </div>
          )}
          {leadsLoading ? (
            <LoadingSkeleton />
          ) : (
            <>
              <div className="space-y-2">
                {leads.map((lead) => {
                  const statusCfg = getStatusConfig(lead.current_status);
                  const lastOutcome = getLastOutcome(
                    lead.follow_up_history ?? [],
                  );
                  const outcomeCfg = lastOutcome
                    ? OUTCOME_CONFIG[lastOutcome]
                    : null;
                  const nextCallLabel = formatNextCall(lead.next_call_at);
                  const isDisabled = NO_CALL_STATUSES.includes(
                    lead.current_status ?? "",
                  );
                  const intentScore = lead.final_intent_score;
                  const rowStatus = getRowStatus(lead.id);
                  const isBeingCalled =
                    rowStatus === "calling" ||
                    (dialerOn &&
                      dialerPhase === "calling" &&
                      currentDialerLead?.id === lead.id);
                  const isCallEnded = rowStatus === "ended";
                  const isUpNext =
                    dialerOn &&
                    dialerPhase === "countdown" &&
                    currentDialerLead?.id === lead.id;

                  return (
                    <div
                      key={lead.id}
                      className={`bg-white border rounded-xl px-5 py-4 transition-all duration-150 ${
                        isBeingCalled
                          ? "border-emerald-400 ring-1 ring-emerald-300 shadow-sm"
                          : isUpNext
                            ? "border-amber-300 ring-1 ring-amber-200"
                            : "border-gray-200 hover:border-gray-300 hover:shadow-sm"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div
                            className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${isBeingCalled ? "bg-emerald-50" : isUpNext ? "bg-amber-50" : "bg-gray-100"}`}
                          >
                            {isBeingCalled ? (
                              <PhoneCall className="w-4 h-4 text-emerald-600 animate-pulse" />
                            ) : (
                              <Store className="w-4 h-4 text-gray-500" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-semibold text-gray-900 truncate">
                                {lead.shop_name || "Unnamed Shop"}
                              </p>
                              {isBeingCalled && (
                                <LeadCallStatus status="calling" />
                              )}
                              {isCallEnded && (
                                <LeadCallStatus status="ended" />
                              )}
                              {isUpNext && (
                                <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-600 shrink-0">
                                  <Clock className="w-3 h-3" /> Up next in{" "}
                                  {countdown}s
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                              <span className="flex items-center gap-1 text-xs text-gray-500">
                                <User className="w-3 h-3" />
                                {lead.dealer_name || "Unknown"}
                              </span>
                              <span className="text-gray-300">·</span>
                              <span className="flex items-center gap-1 text-xs text-gray-400">
                                <MapPin className="w-3 h-3" />
                                {lead.location || "-"}
                              </span>
                              <span className="text-gray-300">·</span>
                              <span className="flex items-center gap-1 text-xs text-gray-400">
                                <Phone className="w-3 h-3" />
                                {lead.phone || "-"}
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                          <span
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${statusCfg.bg} ${statusCfg.text}`}
                          >
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${statusCfg.dot}`}
                            />
                            {statusCfg.label}
                          </span>
                          {intentScore != null && (
                            <span
                              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${getIntentBg(intentScore)} ${getIntentColor(intentScore)}`}
                            >
                              <TrendingUp className="w-3 h-3" />
                              {intentScore}
                            </span>
                          )}
                          {(lead.total_attempts ?? 0) > 0 && (
                            <span className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
                              <RefreshCw className="w-3 h-3" />
                              {lead.total_attempts}x
                            </span>
                          )}
                          {outcomeCfg && (
                            <span
                              className={`text-xs font-medium ${outcomeCfg.color} hidden lg:block`}
                            >
                              {outcomeCfg.label}
                            </span>
                          )}
                          {nextCallLabel && (
                            <span
                              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${nextCallLabel === "Overdue" ? "bg-red-50 text-red-600" : "bg-purple-50 text-purple-600"}`}
                            >
                              <Clock className="w-3 h-3" />
                              {nextCallLabel}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {isDisabled && (
                            <span className="flex items-center gap-1 text-xs text-gray-400">
                              <AlertCircle className="w-3 h-3" /> No calls
                            </span>
                          )}
                          <CallButton
                            leadId={lead.id}
                            phone={lead.phone ?? ""}
                            disabled={isDisabled || !lead.phone}
                            provider="bolna"
                            onCallStart={startCallingLead}
                          />
                          <CallButton
                            leadId={lead.id}
                            phone={lead.phone ?? ""}
                            disabled={isDisabled || !lead.phone}
                            provider="elevenlabs"
                            onCallStart={startCallingLead}
                          />
                          <Link href={`/leads/${lead.id}`}>
                            <button className="px-3 py-1.5 text-xs font-medium border border-gray-200 rounded-lg hover:bg-gray-50 transition-all">
                              View
                            </button>
                          </Link>
                          <Link href={`/leads/${lead.id}/edit`}>
                            <button className="px-3 py-1.5 text-xs font-medium text-gray-500 rounded-lg hover:bg-gray-50 transition-all">
                              Edit
                            </button>
                          </Link>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {leads.length === 0 && (
                <EmptyState label="No dealer leads found" />
              )}
              <Pagination
                page={leadsPage}
                total={leadsTotal}
                limit={LIMIT}
                onChange={setLeadsPage}
              />
            </>
          )}
        </div>
      )}

      {/* ── TAB: CONVERTED LEADS ── */}
      {tab === "converted" && (
        <div>
          {convertedLoading ? (
            <LoadingSkeleton />
          ) : (
            <>
              <div className="space-y-2">
                {convertedLeads.map((lead) => (
                  <ConvertedLeadCard
                    key={lead.id}
                    lead={lead}
                    onUpdate={() => fetchConvertedLeads(convertedPage, search)}
                  />
                ))}
              </div>
              {convertedLeads.length === 0 && (
                <EmptyState label="No converted leads yet" />
              )}
              <Pagination
                page={convertedPage}
                total={convertedTotal}
                limit={LIMIT}
                onChange={setConvertedPage}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Shared components ────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-2">
      {[...Array(5)].map((_, i) => (
        <div
          key={i}
          className="bg-white border border-gray-200 rounded-xl px-5 py-4 animate-pulse"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gray-100" />
            <div className="flex-1 space-y-2">
              <div className="h-3 bg-gray-100 rounded w-40" />
              <div className="h-2.5 bg-gray-100 rounded w-64" />
            </div>
            <div className="h-6 w-20 bg-gray-100 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-12 h-12 bg-gray-100 rounded-2xl flex items-center justify-center mb-3">
        <Store className="w-6 h-6 text-gray-400" />
      </div>
      <p className="text-sm font-medium text-gray-600">{label}</p>
    </div>
  );
}
