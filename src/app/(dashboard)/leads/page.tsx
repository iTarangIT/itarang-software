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
  Download,
} from "lucide-react";
import { SendToNeodoveModal } from "@/components/leads/send-to-neodove-modal";
import { toast } from "sonner";
import { INTENT_THRESHOLDS } from "@/lib/ai/scoring/thresholds";
import { ScraperDashboard } from "@/components/scraper/ScraperDashboard";
import { DownloadConvertedLeadsButton } from "@/components/leads/DownloadButton";
import {
  DialerStartModal,
  type DialerProvider,
  type DialerCategory,
  type DialerStartPayload,
} from "@/components/leads/dialer-start-modal";
import { CampaignBannerExpansion } from "@/components/leads/campaign-banner-expansion";
import { CampaignsTable } from "@/components/leads/campaigns-table";
import { CostAnalyticsView } from "@/components/leads/cost-analytics-view";
import {
  capabilitiesFor,
  LEAD_ASSIGNEE_ROLES,
  NO_CAPABILITIES,
  type LeadsCapabilities,
} from "@/lib/leads/access";
import type { UserOption } from "@/lib/admin/types";
import { UNASSIGNED_FILTER } from "@/lib/admin/leadsInfoFilters";
import type { LeadListFacets } from "@/lib/leads/leadListQuery";
import { LeadsFilterBar } from "./_components/LeadsFilterBar";
import { LeadsStatCards } from "./_components/LeadsStatCards";
import { LeadsTable, type LeadRow } from "./_components/LeadsTable";
import { LeadDrawer } from "./_components/LeadDrawer";
import { LeadsSelectionBar } from "./_components/LeadsSelectionBar";
import {
  EMPTY_FILTERS,
  fromSearchParams,
  hasAnyFilter,
  toSearchParams,
  type LeadFilters,
} from "./_components/filters";

const ENDED_VISIBLE_MS = 8000;
const MANUAL_CALL_MAX_MS = 3 * 60 * 1000;

type Tab = "leads" | "scraper" | "converted" | "campaigns" | "cost-analytics";

// The Cost-Analytics and NeoDove role lists used to be duplicated here as two
// literal Sets. They now live in src/lib/leads/access.ts alongside the
// oversight and bulk-action lists, and GET /api/dealer-leads returns the
// resolved capabilities with the rows — so the page renders what the server
// decided instead of re-deriving it from a copy that can drift.

type DialerPhase = "idle" | "calling" | "countdown";
type UploadStatus = "idle" | "parsing" | "uploading" | "done" | "error";

// SALES_MANAGERS used to be ["SM1","SM2","SM3","SM4"] — placeholder strings,
// not users. The dropdown posted one of them to POST /api/dealer-leads/assign,
// a route that DOES NOT EXIST, with no res.ok check, so every click 404'd
// silently. Even had it existed, its twin at /api/leads/dealer-lead/assign
// writes the literal string into dealer_leads.assigned_to — a plain `text`
// column with no FK, which src/lib/admin/reports.ts:439 notes is NULL on every
// production row precisely because nothing ever reached its only writer.
// Real ownership lives in current_owner_id and is written by the audited
// /api/admin/leads/bulk. The picker now loads real users; see ConvertedLeadCard.

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
  if (score >= INTENT_THRESHOLDS.QUALIFIED) return "text-emerald-600";
  if (score >= INTENT_THRESHOLDS.WARM) return "text-amber-500";
  return "text-red-500";
}
function getIntentBg(score: number | null) {
  if (!score) return "bg-gray-100";
  if (score >= INTENT_THRESHOLDS.QUALIFIED) return "bg-emerald-50";
  if (score >= INTENT_THRESHOLDS.WARM) return "bg-amber-50";
  return "bg-red-50";
}
// formatNextCall / getLastOutcome / OUTCOME_CONFIG moved into
// _components/LeadsTable.tsx with the row rendering they served.
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

// Uses papaparse (already a dependency, used by the AI-dialer list importer).
//
// This replaced a hand-rolled `split(",")` parser that had no quoted-field
// support. Any address containing a comma — "Shop 4, MG Road" — shifted every
// subsequent column left by one, so the phone column silently became a fragment
// of the address and the row was either rejected as invalid or, worse, imported
// against the wrong dealer. Quoted fields, embedded newlines and escaped quotes
// are all handled correctly now.
//
// Server-side parsing lives in src/lib/admin/csvUpload.ts (parseCsvGrid); it
// can't be reused here because that module imports the DB client.
async function parseCSV(text: string): Promise<Record<string, string>[]> {
  const Papa = (await import("papaparse")).default;
  const { data } = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  return data;
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
    reactivated?: number;
    duplicate_skipped?: number;
    address_mismatch?: number;
    invalid_phone?: number;
    failed?: number;
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
        rows = await parseCSV(text);
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
      setResult({
        inserted: data.inserted,
        skipped: data.skipped,
        reactivated: data.reactivated,
        duplicate_skipped: data.duplicate_skipped,
        address_mismatch: data.address_mismatch,
        invalid_phone: data.invalid_phone,
        failed: data.failed,
      });
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
              </p>
              {/* The four dedup outcomes, itemised. The old modal collapsed all
                  of these into "skipped (duplicate phone)", which was wrong on
                  three counts: reactivated leads aren't skipped, address
                  mismatches are queued for a human rather than dropped, and an
                  unparseable phone isn't a duplicate at all. */}
              <div className="mt-3 space-y-1 text-xs">
                {!!result.reactivated && (
                  <p className="text-blue-600">
                    {result.reactivated} previously-lost{" "}
                    {result.reactivated === 1 ? "lead" : "leads"} reactivated
                  </p>
                )}
                {!!result.duplicate_skipped && (
                  <p className="text-gray-400">
                    {result.duplicate_skipped} already in the system — skipped
                  </p>
                )}
                {!!result.address_mismatch && (
                  <p className="text-amber-600">
                    {result.address_mismatch} matched an existing lead at a
                    different address — sent to the admin merge queue
                  </p>
                )}
                {!!result.invalid_phone && (
                  <p className="text-gray-400">
                    {result.invalid_phone} skipped — not a valid 10-digit Indian
                    mobile
                  </p>
                )}
                {!!result.failed && (
                  <p className="text-rose-600">
                    {result.failed} failed — see server logs
                  </p>
                )}
              </div>
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

// Up to 500 because that is what GET /api/dealer-leads caps `limit` at. Ticking
// an arbitrary number of leads — 65, 78 — means being able to SEE that many at
// once, and at 10 a page it takes eight page turns. (The selection does survive
// paging, so that always worked; it was just miserable.)
const PAGE_SIZES = [10, 25, 50, 100, 200, 500];

function Pagination({
  page,
  total,
  limit,
  onChange,
  onLimitChange,
}: {
  page: number;
  total: number;
  limit: number;
  onChange: (p: number) => void;
  /** Omitted by the Converted tab, which has no page-size control. */
  onLimitChange?: (n: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  // Still render when there is only one page — the rows-per-page control lives
  // here, and hiding it at &lt;=1 page would strand anyone who set 100 and then
  // filtered down to a handful.
  if (totalPages <= 1 && !onLimitChange) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1 mt-4">
      <div className="flex items-center gap-3">
        <p className="text-xs text-gray-400">
          {total === 0
            ? "0 results"
            : `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total.toLocaleString("en-IN")}`}
        </p>
        {onLimitChange && (
          <label className="flex items-center gap-1.5 text-xs text-gray-400">
            Rows
            <select
              value={limit}
              onChange={(e) => onLimitChange(Number(e.target.value))}
              className="rounded-lg border border-gray-200 bg-white px-1.5 py-1 text-xs text-gray-600 outline-none focus:border-gray-400"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {totalPages > 1 && (
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
      )}
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
  campaignId,
  expanded,
  onToggleExpanded,
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
  campaignId: string | null;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const providerLabel = provider === "elevenlabs" ? "ElevenLabs" : "Bolna";
  const providerChip =
    provider === "elevenlabs"
      ? "bg-violet-500/20 text-violet-300 border-violet-500/40"
      : "bg-blue-500/20 text-blue-300 border-blue-500/40";
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl px-5 py-4 mb-4">
      <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <button
          type="button"
          onClick={onToggleExpanded}
          disabled={!campaignId}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse campaign details" : "Expand campaign details"}
          className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
            phase === "calling" ? "bg-emerald-500" : "bg-amber-500"
          } ${campaignId ? "hover:brightness-110 cursor-pointer" : "cursor-default"}`}
        >
          {phase === "calling" ? (
            <PhoneCall className="w-4 h-4 text-white animate-pulse" />
          ) : (
            <Clock className="w-4 h-4 text-white" />
          )}
        </button>
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
        {campaignId && (
          <button
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse" : "Expand"}
            className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
          >
            <ChevronDown
              className={`w-4 h-4 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </button>
        )}
      </div>
      </div>
      {expanded && campaignId && (
        <CampaignBannerExpansion campaignId={campaignId} active={phase !== "idle"} />
      )}
    </div>
  );
}

// ─── Converted Lead Card ──────────────────────────────────────

function ConvertedLeadCard({
  lead,
  onUpdate,
  caps,
}: {
  lead: any;
  onUpdate: () => void;
  caps: LeadsCapabilities;
}) {
  const [assigning, setAssigning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [owners, setOwners] = useState<UserOption[]>([]);
  const [ownersError, setOwnersError] = useState(false);
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

  // Load real assignable users the first time the dropdown opens. Distinct
  // query from the shared ["admin-user-options"] pickers — see the note on
  // LEAD_ASSIGNEE_ROLES; this is a plain fetch, so there is no cache to poison,
  // but the roles param is still required or the API returns reps + ASMs only.
  useEffect(() => {
    if (!assigning || owners.length > 0) return;
    let cancelled = false;
    const roles = LEAD_ASSIGNEE_ROLES.join(",");
    fetch(`/api/admin/users?roles=${encodeURIComponent(roles)}`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load failed"))))
      .then((json) => {
        if (!cancelled) setOwners(json?.data?.users ?? []);
      })
      .catch(() => {
        if (!cancelled) setOwnersError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [assigning, owners.length]);

  // Posts to the same audited endpoint the bulk bar and the lead drawer use:
  // it validates the target, writes current_owner_id / asm_id / assigned_at,
  // and records an ownership_transfer touchpoint. The reason is fixed because
  // this is a one-click control; the bulk bar and drawer take a typed reason.
  const handleAssign = async (user: UserOption) => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/leads/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reassign",
          lead_ids: [lead.id],
          target_user_id: user.user_id,
          reason: "Assigned from the Converted Leads list.",
        }),
      });
      const json = await res.json().catch(() => null);
      // The old version ignored the response entirely, which is why a 404 was
      // indistinguishable from a successful assignment.
      if (!res.ok || !json?.success) {
        throw new Error(json?.error?.message ?? `Assign failed (${res.status}).`);
      }
      toast.success(`Assigned to ${user.name ?? user.email}.`);
      onUpdate();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
      setAssigning(false);
    }
  };

  const ownerLabel = lead.current_owner_name ?? null;

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

          {ownerLabel && (
            <span className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-600">
              <User className="w-3 h-3" />
              {ownerLabel}
            </span>
          )}

          {/* Assigning writes ownership, so it is gated on the same roles the
              endpoint enforces (LEADS_BULK_ROLES). Previously every viewer saw
              a button that silently did nothing. */}
          {caps.canBulkAct && (
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
              {ownerLabel ? "Reassign" : "Assign owner"}
              <ChevronDown
                className={`w-3 h-3 text-gray-400 transition-transform ${assigning ? "rotate-180" : ""}`}
              />
            </button>

            {assigning && (
              <div className="absolute right-0 top-full mt-1 w-48 bg-white border border-gray-200 rounded-xl shadow-lg z-20 overflow-hidden">
                <div className="px-3 py-2 border-b">
                  <p className="text-xs font-medium text-gray-500">
                    Assign to
                  </p>
                </div>
                <div className="py-1 max-h-64 overflow-y-auto">
                  {ownersError && (
                    <p className="px-3 py-2 text-xs text-rose-600">
                      Could not load users.
                    </p>
                  )}
                  {!ownersError && owners.length === 0 && (
                    <p className="px-3 py-2 text-xs text-gray-400">Loading…</p>
                  )}
                  {owners.map((u) => {
                    const isCurrent = u.user_id === lead.current_owner_id;
                    return (
                      <button
                        key={u.user_id}
                        onClick={() => handleAssign(u)}
                        disabled={isCurrent}
                        className={`w-full text-left px-3 py-2 text-xs hover:bg-gray-50 transition-colors flex items-center justify-between gap-2 disabled:opacity-50 ${isCurrent ? "text-blue-600 font-medium" : "text-gray-700"}`}
                      >
                        <span className="min-w-0 truncate">
                          {u.name ?? u.email}
                          {u.role && (
                            <span className="ml-1 text-gray-400">
                              · {u.role.replaceAll("_", " ")}
                            </span>
                          )}
                        </span>
                        {isCurrent && (
                          <CheckCircle className="w-3 h-3 shrink-0 text-blue-500" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          )}

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
    return t === "scraper" ||
      t === "converted" ||
      t === "campaigns" ||
      t === "cost-analytics"
      ? t
      : "leads";
  })();

  // What this user may see and do on this page: the Cost Analytics tab, the
  // NeoDove hand-off, the Owner/ASM columns, and the bulk actions.
  //
  // Derived from one profile fetch so the tab strip can render before any lead
  // data lands; GET /api/dealer-leads then returns the SAME object computed
  // server-side and we adopt that (see fetchLeads). The server is the authority
  // — this is only so the UI doesn't flash controls it is about to hide.
  // Defaults to all-false so a failed fetch hides actions the API would refuse.
  const [caps, setCaps] = useState(NO_CAPABILITIES);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/user/profile")
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        const role = json?.data?.role as string | undefined;
        if (role) setCaps(capabilitiesFor(role));
      })
      .catch(() => {
        // Silent failure — controls stay hidden.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const canSeeCostAnalytics = caps.canSeeCostAnalytics;
  const [tab, setTab] = useState<Tab>(initialTab);
  const [search, setSearch] = useState("");
  const [showUpload, setShowUpload] = useState(false);

  const [leads, setLeads] = useState<any[]>([]);
  const [leadsTotal, setLeadsTotal] = useState(0);
  // Stats panel counters — server-side, computed across all matching leads
  // (not just the current page). Default to zeros so the cards render before
  // the first fetch lands.
  const [leadsStats, setLeadsStats] = useState({
    hot: 0,
    warm: 0,
    cold: 0,
    unassigned: 0,
    scheduled: 0,
  });
  // Owner / ASM / source dropdown options, served alongside the rows so the
  // filter bar never needs its own request.
  const [facets, setFacets] = useState<LeadListFacets | undefined>(undefined);
  // Lead opened in the side drawer (row click).
  const [drawerLead, setDrawerLead] = useState<LeadRow | null>(null);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [leadsPage, setLeadsPage] = useState(1);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [leadsError, setLeadsError] = useState<string | null>(null);
  // ── Merged-list filters ───────────────────────────────────────────────
  // `draft` is what the user is typing; `applied` is what has been sent. The
  // 350ms debounce between them stops every keystroke from firing a request —
  // the pattern the old Leads Info page used, which the un-debounced /leads
  // search lacked.
  //
  // Seeded from the URL so /admin/leads-info?status=Lost&owner_id=… can redirect
  // here and land on the same filtered view, keeping old bookmarks alive.
  const [draft, setDraft] = useState<LeadFilters>(() =>
    fromSearchParams(new URLSearchParams(searchParams?.toString() ?? "")),
  );
  const [applied, setApplied] = useState<LeadFilters>(draft);
  useEffect(() => {
    const t = window.setTimeout(() => {
      setApplied(draft);
      setLeadsPage(1);
    }, 350);
    return () => window.clearTimeout(t);
  }, [draft]);

  const setFilter = useCallback((key: keyof LeadFilters, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
  }, []);
  // The three disposition levels narrow each other, so picking one has to clear
  // the narrower ones in the SAME update — three sequential setFilter calls
  // would each debounce and fire an intermediate request for a filter
  // combination the operator never asked for.
  const patchFilters = useCallback((patch: Partial<LeadFilters>) => {
    setDraft((d) => ({ ...d, ...patch }));
  }, []);
  const setDateRange = useCallback((from: string, to: string) => {
    setDraft((d) => ({ ...d, from, to }));
  }, []);
  const clearFilters = useCallback(() => setDraft(EMPTY_FILTERS), []);

  // Bulk NeoDove hand-off. Selection is scoped to the leads currently on
  // screen and cleared whenever the visible set changes — carrying a hidden
  // selection across pages or filters would mean sending leads the operator
  // can no longer see, and a NeoDove push cannot be undone.
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [showBulkNeodove, setShowBulkNeodove] = useState(false);
  // "Select all N matching" — in flight, and the cap if the match count
  // exceeded what a bulk action accepts.
  const [selectingAll, setSelectingAll] = useState(false);
  const [selectionCap, setSelectionCap] = useState<number | null>(null);
  // Clearing on ANY filter change is load-bearing: a selection carried across
  // a filter change would let a bulk Reassign or a NeoDove push hit leads the
  // operator can no longer see, and neither can be undone.
  //
  // Paging deliberately does NOT clear any more. It used to, which made a
  // cross-page selection impossible — and "select all 3,000 matching" is the
  // whole point of a bulk action. What made clearing necessary was the
  // selection being invisible; the sticky bar now shows the running count and a
  // Clear at all times, so carrying it across pages is both safe and expected.
  useEffect(() => {
    setSelectedLeadIds(new Set());
    setSelectionCap(null);
  }, [applied, tab]);

  const toggleLeadSelected = (id: string) => {
    setSelectedLeadIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
  // Campaign id for the current dialer session; populated by /start response
  // and reaffirmed by the /status poller. Drives the expandable banner panel
  // and the link into the campaign detail page.
  const [currentCampaignId, setCurrentCampaignId] = useState<string | null>(null);
  const [bannerExpanded, setBannerExpanded] = useState(false);

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

  // getRowStatus() lived here to colour each row while the dialer ran. That
  // now happens inside _components/LeadsTable.tsx, which receives callingLeadId
  // / dialerPhase / endedLeadIds as props and derives the same three states.
  const [dialerCallsMade, setDialerCallsMade] = useState(0);
  const [countdown, setCountdown] = useState(COUNTDOWN_SECS);

  // Guards against out-of-order lead fetches: rapid filter changes (e.g.
  // setting the From then To date fires two requests near-simultaneously) can
  // resolve out of order, letting a stale response overwrite the latest. Each
  // fetch claims a sequence number and only applies its result if still newest.
  const fetchSeqRef = useRef(0);

  const countdownRef = useRef<NodeJS.Timeout | null>(null);
  const pollerRef = useRef<NodeJS.Timeout | null>(null);
  const stopRef = useRef(false);
  const queueRef = useRef<any[]>([]);
  const indexRef = useRef(0);

  // Rows per page. Was hardcoded to 10, which is why "select all on this page"
  // never felt like a bulk action. Changing it resets to page 1 — staying on
  // page 40 of a 10-per-page list makes no sense at 100 per page.
  //
  // Defaults to 25, not 10. This is a screen whose main job is picking a set of
  // leads and doing something to all of them, and ten rows is below the size of
  // a normal selection — it made every bulk action feel like it had a limit of
  // ten, which was the complaint.
  const [LIMIT, setLimit] = useState(25);

  const fetchLeads = useCallback(
    async (
      page: number,
      f: LeadFilters,
      opts?: { silent?: boolean },
    ) => {
      // When the dialer is running we re-fetch every 2s to surface lead
      // status transitions. `silent` skips the loading spinner so the
      // table doesn't flash during background refreshes.
      const silent = opts?.silent === true;
      const seq = ++fetchSeqRef.current;
      if (!silent) setLeadsLoading(true);
      try {
        const params = toSearchParams(f, page, LIMIT);
        const res = await fetch(`/api/dealer-leads?${params.toString()}`);
        const data = await res.json();
        // A newer fetch superseded this one while it was in flight — drop the
        // stale result so it can't clobber the latest filter's data.
        if (seq !== fetchSeqRef.current) return;
        if (data.success) {
          setLeads(data.leads);
          setLeadsTotal(data.total);
          if (data.stats) setLeadsStats(data.stats);
          if (data.facets) setFacets(data.facets);
          // The server decides what this role may see and do; the client just
          // renders it. Keeps the gate in one place instead of duplicating role
          // lists here and hoping they stay in sync with the APIs.
          if (data.capabilities) setCaps(data.capabilities);
          setLeadsError(null);
        } else {
          // Surface API failures instead of rendering a silent empty state.
          // Most commonly this fires when schema.ts and the live DB drift —
          // e.g. a new E-NNN migration hasn't been applied to the host the
          // dev server connects to (check the [DB] log on server start).
          console.error("[leads] /api/dealer-leads failed:", data);
          if (!silent) {
            setLeads([]);
            setLeadsTotal(0);
          }
          setLeadsError(data.error?.message ?? data.error ?? "Failed to load leads");
        }
      } catch (err: any) {
        if (seq !== fetchSeqRef.current) return;
        console.error("[leads] /api/dealer-leads network error:", err);
        if (!silent) {
          setLeads([]);
          setLeadsTotal(0);
        }
        setLeadsError(err?.message ?? "Network error loading leads");
      } finally {
        if (!silent && seq === fetchSeqRef.current) setLeadsLoading(false);
      }
    },
    [],
  );

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

  // LIMIT is in here on purpose. Without it, changing rows-per-page while
  // already on page 1 did nothing at all: the setter also calls setLeadsPage(1),
  // which is a no-op from page 1, so no dependency changed and no refetch ran.
  // The dropdown said 50 and the table kept showing 25.
  useEffect(() => {
    if (tab === "leads") fetchLeads(leadsPage, applied);
    if (tab === "converted") fetchConvertedLeads(convertedPage, search);
  }, [tab, leadsPage, convertedPage, search, applied, LIMIT]);

  // While the AI dialer is running, poll the leads list every 2s so the
  // `current_status` column reflects lead transitions (pending → calling
  // → completed) without forcing the user to refresh. Silent refresh —
  // no loading flash. Polling stops the moment dialerOn flips back to
  // false, so this costs nothing when no campaign is active.
  useEffect(() => {
    if (tab !== "leads" || !dialerOn) return;
    const id = setInterval(() => {
      fetchLeads(leadsPage, applied, { silent: true });
    }, 2000);
    return () => clearInterval(id);
  }, [tab, dialerOn, leadsPage, applied, fetchLeads]);

  // Search box on the header row now belongs to the Converted tab only — the
  // Leads tab has its own search inside LeadsFilterBar, wired to `draft`.
  const handleSearch = (v: string) => {
    setSearch(v);
    setConvertedPage(1);
  };

  // Pulls every id matching the active filters, not just the visible page.
  const selectAllMatching = useCallback(async () => {
    setSelectingAll(true);
    try {
      const params = toSearchParams(applied, 1, LIMIT);
      params.set("ids_only", "1");
      const res = await fetch(`/api/dealer-leads?${params.toString()}`);
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error?.message ?? "Could not select all leads.");
      }
      setSelectedLeadIds(new Set<string>(data.ids ?? []));
      setSelectionCap(data.capped ? data.cap : null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSelectingAll(false);
    }
  }, [applied]);

  // "Select exactly N" — type a number, get that many leads.
  //
  // Takes the FIRST n of the same id list selectAllMatching uses, which is
  // ordered identically to the visible table (last_touchpoint_at DESC, then
  // created_at DESC). So "first 65" means the 65 rows you would reach by
  // scrolling, not an arbitrary 65 — that correspondence is the whole reason
  // this is trustworthy enough to hand to a bulk action.
  //
  // REPLACES the selection rather than adding to it: the input reads as "how
  // many do I want selected", so typing 65 must end with 65 selected, not 115.
  const selectFirstN = useCallback(
    async (n: number) => {
      if (!Number.isFinite(n) || n < 1) return;
      setSelectingAll(true);
      try {
        const params = toSearchParams(applied, 1, LIMIT);
        params.set("ids_only", "1");
        const res = await fetch(`/api/dealer-leads?${params.toString()}`);
        const data = await res.json();
        if (!res.ok || !data?.success) {
          throw new Error(data?.error?.message ?? "Could not select leads.");
        }
        const ids: string[] = data.ids ?? [];
        const take = ids.slice(0, n);
        setSelectedLeadIds(new Set<string>(take));

        // Grow the page so the selection is VISIBLE. Selecting 100 while the
        // table shows 25 is correct but reads as broken — the bar says 100 and
        // you can count 25 ticks. Jump to the smallest page size that holds
        // them (or the largest we offer, if they asked for more than that).
        // Changing LIMIT does not clear the selection: that only happens when
        // `applied` or `tab` changes, and neither does here.
        if (take.length > LIMIT) {
          const fits = PAGE_SIZES.find((size) => size >= take.length);
          setLimit(fits ?? PAGE_SIZES[PAGE_SIZES.length - 1]);
          setLeadsPage(1);
        }
        // Only a cap if it actually bit — asking for 65 out of 3,255 is not
        // capped just because the id fetch stops at 5,000.
        setSelectionCap(take.length < n && data.capped ? data.cap : null);
        if (take.length < n) {
          toast.success(
            `Selected ${take.length.toLocaleString("en-IN")} — that is all that matched.`,
          );
        }
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setSelectingAll(false);
      }
    },
    [applied, LIMIT],
  );

  // CSV of every lead matching the ACTIVE filters — not the page, not the
  // selection. Same params the table fetched with, so the sheet is exactly what
  // is on screen, only complete.
  const [exportingCsv, setExportingCsv] = useState(false);
  const exportFilteredCsv = useCallback(async () => {
    setExportingCsv(true);
    try {
      // page/limit are irrelevant to the export but toSearchParams is the one
      // place that knows every filter's query-param name; passing 1 and 1 keeps
      // that single source of truth rather than re-listing the params here.
      const params = toSearchParams(applied, 1, 1);
      params.delete("page");
      params.delete("limit");
      const res = await fetch(`/api/dealer-leads/export?${params.toString()}`);
      if (!res.ok) {
        // The route returns JSON on failure and CSV on success, so read as text
        // and show whatever it said rather than downloading an error page.
        const detail = await res.text().catch(() => "");
        throw new Error(detail.slice(0, 200) || "Export failed");
      }
      const rowCount = Number(res.headers.get("X-Export-Rows") ?? 0);
      const matched = Number(res.headers.get("X-Export-Total") ?? 0);
      const truncated = res.headers.get("X-Export-Truncated") === "1";

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // Server already set a dated filename in Content-Disposition; this is the
      // fallback for browsers that ignore it on a blob URL.
      a.download = "leads-export.csv";
      a.click();
      URL.revokeObjectURL(url);

      if (truncated) {
        toast.warning(
          `Exported the first ${rowCount.toLocaleString("en-IN")} of ${matched.toLocaleString("en-IN")} matches. Narrow the filters to get the rest.`,
        );
      } else {
        toast.success(
          `Exported ${rowCount.toLocaleString("en-IN")} lead${rowCount === 1 ? "" : "s"}.`,
        );
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExportingCsv(false);
    }
  }, [applied]);

  const refreshLeads = useCallback(() => {
    fetchLeads(leadsPage, applied, { silent: true });
  }, [fetchLeads, leadsPage, applied]);

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
          // Session ended on the backend — queue exhausted. Keep
          // currentCampaignId so the user can still expand and see the
          // final breakdown until they navigate away or click Stop.
          if (pollerRef.current) clearInterval(pollerRef.current);
          setDialerOn(false);
          setDialerPhase("idle");
          return;
        }
        if (status.provider && status.provider !== dialerProvider) {
          setDialerProvider(status.provider as DialerProvider);
        }
        if (status.campaignId && status.campaignId !== currentCampaignId) {
          setCurrentCampaignId(status.campaignId);
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
    async ({ provider, category, region, filters, queue }: DialerStartPayload) => {
      if (queue.length === 0) return;

      stopRef.current = false;
      queueRef.current = queue;
      setDialerQueue(queue);
      setDialerIndex(0);
      setDialerCallsMade(0);
      setDialerProvider(provider);
      setDialerOn(true);
      setDialerPhase("calling");

      const startRes = await fetch("/api/ai-dialer/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queueIds: queue.map((l) => l.id),
          provider,
          category,
          // Audit/telemetry only — the server still trusts queueIds as
          // the authoritative list. See /api/ai-dialer/start/route.ts.
          //
          // `filters` rides inside `region` because that whole blob is what
          // gets stored verbatim as dialer_campaigns.region_filter, and the
          // column has carried non-region keys (kind, recall, groupNames) since
          // E-109. Adding a real audience_filter column would be better naming
          // but would make the migration a hard deploy prerequisite —
          // dialer_campaigns IS mirrored in schema.ts, so a database without it
          // fails on every campaign INSERT.
          region: { ...region, filters },
        }),
      });
      try {
        const startJson = await startRes.json();
        if (startJson?.campaignId) {
          setCurrentCampaignId(startJson.campaignId);
        }
      } catch {
        // Non-fatal; the /status poller will surface campaignId on the next tick.
      }

      // First call is now placed server-side by /api/ai-dialer/start via
      // advanceCampaign. Just light up the row optimistically and start
      // polling — the campaign-lead row's status='calling' from the DB
      // is what /api/ai-dialer/status now reflects.
      const head = queue[0];
      startCallingLead(head.id);
      setDialerCallsMade(1);
      startDialerPoller();
    },
    [startDialerPoller, startCallingLead],
  );

  // Launch a draft list campaign (created in the modal's Lists tab). The
  // campaign dials server-side; we don't hold the lead objects locally, so the
  // live banner reads counts from /api/ai-dialer/status. Light up the session
  // indicator and jump to the Campaigns tab to watch it run.
  const startListCampaign = useCallback(
    async (campaignId: string, provider: DialerProvider) => {
      const res = await fetch(`/api/ai-dialer/lists/${campaignId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error(json?.error?.message ?? "Failed to start the campaign");
        return;
      }
      stopRef.current = false;
      queueRef.current = [];
      setDialerQueue([]);
      setDialerIndex(0);
      setDialerCallsMade(1);
      setDialerProvider(provider);
      setCurrentCampaignId(campaignId);
      setDialerOn(true);
      setDialerPhase("calling");
      startDialerPoller();
      setTab("campaigns");
    },
    [startDialerPoller],
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
    setCurrentCampaignId(null);
    setBannerExpanded(false);
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

  const currentDialerLead = dialerQueue[dialerIndex] ?? null;
  const nextDialerLead = dialerQueue[dialerIndex + 1] ?? null;

  return (
    // Widened from max-w-6xl (1152px) when Leads Info merged in: the list now
    // carries the oversight columns too (qualification, owner, ASM, visit) and
    // was cramped at the old width. Matches the max-w-[1600px] the Leads Info
    // page used for the same table.
    <div className="max-w-[1600px] mx-auto py-8 px-6 min-h-screen bg-gray-50">
      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onSuccess={() => fetchLeads(1, applied)}
        />
      )}

      <DialerStartModal
        isOpen={dialerModalOpen}
        onClose={() => setDialerModalOpen(false)}
        onConfirm={confirmDialerStart}
        onStartListCampaign={startListCampaign}
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
          {/* Exports what the FILTERS match, not what is selected — the bulk
              bar's Export CSV already covers a selection. Uses `applied`, the
              debounced filter state the table itself is showing, so the sheet
              and the screen are the same set of leads. */}
          {tab === "leads" && (
            <button
              onClick={exportFilteredCsv}
              disabled={exportingCsv}
              title="Download every lead matching the current filters"
              className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-xl hover:border-gray-300 hover:bg-gray-50 transition-all shadow-sm disabled:opacity-50"
            >
              {exportingCsv ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              Export CSV
            </button>
          )}
          {/* "Add Lead" stood here — single-lead entry into the PROSPECT pool
              (dealer_leads), as distinct from "New Lead" on the right, which
              opens the 5-step loan-application wizard against `leads`. Removed
              on request, along with its now-unreachable modal render, state and
              import.
              To restore: re-import AddLeadModal from
              @/components/leads/add-lead-modal, add `showAddLead` state, put the
              button back here, and render the modal beside DialerStartModal. The
              component itself and POST /api/dealer-leads are untouched — leads
              still arrive from Import, Bulk Lead Upload, the scraper and
              NeoDove. */}
          {/* ── Download button shown only on Converted tab ── */}
          {tab === "converted" && <DownloadConvertedLeadsButton />}
          <Link href="/leads/new">
            <button className="flex items-center gap-2 px-4 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-700 transition-all">
              <Plus className="w-4 h-4" /> New Lead
            </button>
          </Link>
        </div>
      </div>

      {/* STATS ROW — each card is also a filter. */}
      {tab === "leads" && (
        <LeadsStatCards
          total={leadsTotal}
          stats={leadsStats}
          filters={draft}
          onIntent={(b) => setFilter("intent", b)}
          onUnassigned={() =>
            setFilter(
              "status",
              draft.status === UNASSIGNED_FILTER ? "" : UNASSIGNED_FILTER,
            )
          }
          unassignedActive={draft.status === UNASSIGNED_FILTER}
        />
      )}

      {/* TABS + SEARCH */}
      <div className="flex items-center justify-between mb-4 gap-4">
        <div className="flex items-center bg-white border border-gray-200 rounded-xl p-1 gap-1 overflow-x-auto min-w-0">
          {(
            [
              { key: "scraper", label: "Scraper" },
              { key: "leads", label: "Leads" },
              { key: "converted", label: "My Converted Leads" },
              { key: "campaigns", label: "Campaigns" },
              ...(canSeeCostAnalytics
                ? [{ key: "cost-analytics" as Tab, label: "Cost Analytics" }]
                : []),
            ] as { key: Tab; label: string }[]
          ).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => {
                setTab(key);
              }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap shrink-0 ${tab === key ? "bg-gray-900 text-white shadow-sm" : "text-gray-500 hover:text-gray-800"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "converted" && (
            <div className="relative shrink-0">
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

      {/* FILTER BAR (Leads tab) — search, qualification, intent, owner, created
          range, and the drill-downs behind "More filters". Everything here
          drives the stat cards AND the list from one shared WHERE clause. */}
      {tab === "leads" && (
        <div className="mb-5">
          <LeadsFilterBar
            draft={draft}
            onChange={setFilter}
            onPatch={patchFilters}
            onClear={clearFilters}
            facets={facets}
            caps={caps}
            showMore={showMoreFilters}
            onToggleMore={() => setShowMoreFilters((v) => !v)}
            onDateRange={setDateRange}
            busy={leadsLoading}
          />
        </div>
      )}

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
              campaignId={currentCampaignId}
              expanded={bannerExpanded}
              onToggleExpanded={() => setBannerExpanded((v) => !v)}
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
          {/* Selection bar lives BELOW the table now (sticky) — see
              _components/LeadsSelectionBar.tsx. */}

          {showBulkNeodove && (
            <SendToNeodoveModal
              leadIds={[...selectedLeadIds]}
              label={`${selectedLeadIds.size} lead${selectedLeadIds.size === 1 ? "" : "s"}`}
              onClose={() => setShowBulkNeodove(false)}
              onSent={() => setSelectedLeadIds(new Set())}
            />
          )}

          {/* Rows-per-page, ABOVE the table as well as below it.
              It already existed at the bottom of the list, in small grey text
              under several hundred pixels of rows — so the practical experience
              was "I can only ever select ten", and the fix for it was invisible
              at the moment you needed it. Selection is made here; the control
              that governs how much you can select belongs here too. */}
          <div className="mt-3 flex items-center justify-end gap-2 px-1">
            <label className="flex items-center gap-1.5 text-xs text-gray-500">
              Rows per page
              <select
                value={LIMIT}
                onChange={(e) => {
                  setLimit(Number(e.target.value));
                  setLeadsPage(1);
                }}
                className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 outline-none focus:border-gray-400"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            {leads.length > 0 && leadsTotal > leads.length && (
              <span className="text-xs text-gray-400">
                · tick the header box to take all {leads.length} on this page
              </span>
            )}
          </div>

          <LeadsTable
            rows={leads as LeadRow[]}
            loading={leadsLoading}
            caps={caps}
            hasFilters={hasAnyFilter(draft)}
            selected={selectedLeadIds}
            onToggle={toggleLeadSelected}
            onToggleAll={() =>
              setSelectedLeadIds((prev) => {
                // Scoped to the visible page. Returning an empty Set here (what
                // it used to do) would also discard everything selected on
                // other pages, which a cross-page selection makes destructive.
                const next = new Set(prev);
                const allOnPage =
                  leads.length > 0 && leads.every((l) => next.has(l.id));
                for (const l of leads) {
                  if (allOnPage) next.delete(l.id as string);
                  else next.add(l.id as string);
                }
                return next;
              })
            }
            onOpen={setDrawerLead}
            onRefresh={refreshLeads}
            onCallStart={startCallingLead}
            dialerLeadId={
              dialerOn ? (currentDialerLead?.id ?? callingLeadId) : callingLeadId
            }
            dialerPhase={dialerOn ? dialerPhase : "idle"}
            countdown={countdown}
            endedLeadIds={new Set(endedLeadIds.keys())}
          />

          <LeadsSelectionBar
            selectedCount={selectedLeadIds.size}
            pageCount={leads.length}
            total={leadsTotal}
            allOnPageSelected={
              leads.length > 0 &&
              leads.every((l) => selectedLeadIds.has(l.id))
            }
            allMatchingSelected={selectedLeadIds.size >= leadsTotal}
            selectAllMatching={selectAllMatching}
            selectFirstN={selectFirstN}
            selectingAll={selectingAll}
            cappedAt={selectionCap}
            onClear={() => {
              setSelectedLeadIds(new Set());
              setSelectionCap(null);
            }}
            caps={caps}
            selectedIds={[...selectedLeadIds]}
            onBulkDone={() => {
              setSelectedLeadIds(new Set());
              setSelectionCap(null);
              refreshLeads();
            }}
            onSendToNeodove={() => setShowBulkNeodove(true)}
          />

          <Pagination
            page={leadsPage}
            total={leadsTotal}
            limit={LIMIT}
            onChange={setLeadsPage}
            onLimitChange={(n) => {
              setLimit(n);
              setLeadsPage(1);
            }}
          />

          <LeadDrawer
            lead={drawerLead}
            caps={caps}
            onClose={() => setDrawerLead(null)}
            onDone={refreshLeads}
          />
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
                    caps={caps}
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

      {/* ── TAB: CAMPAIGNS (AI dialer history) ── */}
      {tab === "campaigns" && (
        <div>
          <CampaignsTable />
        </div>
      )}

      {/* ── TAB: COST ANALYTICS (enterprise cost dashboard) ── */}
      {tab === "cost-analytics" && canSeeCostAnalytics && (
        <CostAnalyticsView />
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
