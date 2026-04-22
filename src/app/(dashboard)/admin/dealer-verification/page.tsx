"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Building2,
  Clock3,
  Search,
  ShieldCheck,
  ArrowRight,
  CheckCircle2,
  CalendarDays,
  Download,
  X,
  UserCog,
  AlertTriangle,
  GitBranch,
} from "lucide-react";

type DuplicateFlag = "none" | "branch" | "duplicate" | "pan-mismatch";

function DuplicateBadge({ flag }: { flag?: DuplicateFlag | null }) {
  if (!flag || flag === "none") return null;

  if (flag === "branch") {
    return (
      <span
        title="Shares GSTIN with another dealer — will be approved as an additional location."
        className="ml-2 inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700"
      >
        <GitBranch className="h-3 w-3" />
        Branch
      </span>
    );
  }

  if (flag === "duplicate") {
    return (
      <span
        title="Another dealer with same GSTIN + PAN + address already exists. Approval is blocked."
        className="ml-2 inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700"
      >
        <AlertTriangle className="h-3 w-3" />
        Duplicate
      </span>
    );
  }

  // pan-mismatch
  return (
    <span
      title="GSTIN registered under a different PAN. Verify data before approving."
      className="ml-2 inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700"
    >
      <AlertTriangle className="h-3 w-3" />
      PAN mismatch
    </span>
  );
}

type DealerVerificationItem = {
  dealerId: string;
  dealerName: string;
  companyName: string;
  documents: string;
  agreement: string;
  status: string;
  submittedAt?: string | null;
  gstNumber?: string | null;
  financeEnabled?: boolean | null;
  companyType?: string | null;
  salesManagerName?: string | null;
  salesManagerEmail?: string | null;
  salesManagerMobile?: string | null;
  duplicateFlag?: DuplicateFlag | null;
  isBranchDealer?: boolean | null;
};

function StatCard({
  title,
  value,
  subtitle,
  icon,
}: {
  title: string;
  value: string | number;
  subtitle: string;
  icon: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28 }}
      className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-slate-500">{title}</p>
          <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">
            {value}
          </h3>
          <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
        </div>
        <div className="rounded-2xl bg-slate-50 p-3 text-slate-700">{icon}</div>
      </div>
    </motion.div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: "bg-slate-50 text-slate-600 border-slate-200",
    submitted: "bg-amber-50 text-amber-700 border-amber-200",
    pending_admin_review: "bg-amber-50 text-amber-700 border-amber-200",
    under_review: "bg-blue-50 text-blue-700 border-blue-200",
    under_correction: "bg-orange-50 text-orange-700 border-orange-200",
    correction_requested: "bg-orange-50 text-orange-700 border-orange-200",
    approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
    completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
    succeed: "bg-emerald-50 text-emerald-700 border-emerald-200",
    rejected: "bg-rose-50 text-rose-700 border-rose-200",
  };

  const classes = map[status] || "bg-slate-50 text-slate-700 border-slate-200";

  return (
    <span
      className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold capitalize ${classes}`}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}

function AgreementBadge({ value }: { value: string }) {
  const normalized = (value ?? "").toLowerCase();

  if (normalized === "n/a")
    return (
      <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-500">
        N/A
      </span>
    );

  if (normalized === "not_generated")
    return (
      <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
        Not Generated
      </span>
    );

  if (normalized === "sent_for_signature")
    return (
      <span className="inline-flex rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
        Sent for Signing
      </span>
    );

  if (normalized === "partially_signed")
    return (
      <span className="inline-flex rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
        Partially Signed
      </span>
    );

  if (normalized === "completed")
    return (
      <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
        Signed
      </span>
    );

  if (normalized === "failed" || normalized === "expired")
    return (
      <span className="inline-flex rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-700">
        {value.replaceAll("_", " ")}
      </span>
    );

  return (
    <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
      {value || "—"}
    </span>
  );
}

function DocumentBadge({ value }: { value: string }) {
  const lower = (value ?? "").toLowerCase();
  const classes =
    lower === "none uploaded"
      ? "border-slate-200 bg-slate-50 text-slate-500"
      : lower.includes("uploaded")
        ? "border-blue-200 bg-blue-50 text-blue-700"
        : "border-slate-200 bg-slate-50 text-slate-700";

  return (
    <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${classes}`}>
      {value || "—"}
    </span>
  );
}

export default function DealerVerificationPage() {
  const [applications, setApplications] = useState<DealerVerificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const isFilterActive = dateFrom !== "" || dateTo !== "";

  useEffect(() => {
    const loadApplications = async () => {
      try {
        const res = await fetch("/api/admin/dealer-verifications");
        const data = await res.json();
        if (data.success) setApplications(data.applications || []);
      } catch (error) {
        console.error("Failed to load dealer verifications", error);
      } finally {
        setLoading(false);
      }
    };
    loadApplications();
  }, []);

  // Parse a "YYYY-MM-DD" input value into a local-midnight Date so day
  // boundaries align with the user's timezone (new Date("YYYY-MM-DD") parses
  // as UTC and shifts off by a day in many timezones).
  const parseLocalDate = (value: string): Date | null => {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  };

  // Reactive filtering — no Apply button needed
  const filtered = useMemo(() => {
    let result = applications;

    if (dateFrom || dateTo) {
      result = result.filter((item) => {
        if (!item.submittedAt) return false;
        const submitted = new Date(item.submittedAt);
        submitted.setHours(0, 0, 0, 0);
        if (dateFrom) {
          const from = parseLocalDate(dateFrom);
          if (from) {
            from.setHours(0, 0, 0, 0);
            if (submitted < from) return false;
          }
        }
        if (dateTo) {
          const to = parseLocalDate(dateTo);
          if (to) {
            to.setHours(23, 59, 59, 999);
            if (submitted > to) return false;
          }
        }
        return true;
      });
    }

    const q = query.trim().toLowerCase();
    if (q) {
      result = result.filter((item) =>
        [
          item.dealerName,
          item.companyName,
          item.gstNumber || "",
          item.status,
          item.companyType || "",
          item.salesManagerName || "",
          item.salesManagerEmail || "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(q)
      );
    }

    return result;
  }, [applications, query, dateFrom, dateTo]);

  const stats = useMemo(() => {
    const total = applications.length;
    const pending = applications.filter((a) =>
      [
        "submitted",
        "pending_admin_review",
        "pending_sales_head",
        "under_review",
        "agreement_in_progress",
      ].includes(a.status)
    ).length;
    const approved = applications.filter((a) =>
      ["approved", "completed", "succeed"].includes(a.status)
    ).length;
    const correction = applications.filter((a) =>
      ["under_correction", "correction_requested"].includes(a.status)
    ).length;
    return { total, pending, approved, correction };
  }, [applications]);

  const formatDisplayDate = (d: string) => {
    const parsed = parseLocalDate(d) ?? new Date(d);
    return parsed.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  };

  const activeFilterLabel =
    dateFrom && dateTo
      ? `${formatDisplayDate(dateFrom)} – ${formatDisplayDate(dateTo)}`
      : dateFrom
        ? `From ${formatDisplayDate(dateFrom)}`
        : dateTo
          ? `Until ${formatDisplayDate(dateTo)}`
          : "";

  const exportHref = useMemo(() => {
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    const trimmedQuery = query.trim();
    if (trimmedQuery) params.set("q", trimmedQuery);
    const qs = params.toString();
    return qs
      ? `/api/admin/dealer-verifications/export?${qs}`
      : `/api/admin/dealer-verifications/export`;
  }, [dateFrom, dateTo, query]);

  const exportDisabled = loading || filtered.length === 0;

  return (
    <div className="space-y-8 px-1">
      {/* ── Page Header ── */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28 }}
        className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-slate-400">
              Dealer Verification
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">
              Dealer Verification Console
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-500">
              Review dealer onboarding submissions, validate documents and agreement flow, and
              activate approved dealer accounts with a controlled compliance workflow.
            </p>
          </div>

          <div className="relative w-full lg:w-[360px]">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search dealer, GST, sales manager, status..."
              className="h-12 w-full rounded-2xl border border-slate-200 bg-slate-50 pl-11 pr-4 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:bg-white"
            />
          </div>
        </div>
      </motion.div>

      {/* ── Stats Row ── */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Total Applications" value={stats.total} subtitle="All onboarding submissions" icon={<Building2 className="h-5 w-5" />} />
        <StatCard title="Pending Review" value={stats.pending} subtitle="Waiting for admin action" icon={<Clock3 className="h-5 w-5" />} />
        <StatCard title="Approved" value={stats.approved} subtitle="Dealer accounts activated" icon={<CheckCircle2 className="h-5 w-5" />} />
        <StatCard title="Correction Cases" value={stats.correction} subtitle="Need dealer clarification" icon={<ShieldCheck className="h-5 w-5" />} />
      </div>

      {/* ── Applications Table ── */}
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32 }}
        className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm"
      >
        {/* Table header + date filter */}
        <div className="border-b border-slate-200 px-6 py-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Applications Queue</h2>
              <p className="mt-1 text-sm text-slate-500">
                Pending admin review, correction cases, and approval actions.
              </p>
            </div>

            {/* Date range inputs */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
                <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
                <span className="text-xs font-medium text-slate-500">Submitted date</span>
              </div>

              <input
                type="date"
                value={dateFrom}
                max={dateTo || undefined}
                onChange={(e) => setDateFrom(e.target.value)}
                className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              />

              <span className="text-xs text-slate-400">—</span>

              <input
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(e) => setDateTo(e.target.value)}
                className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              />

              {isFilterActive && (
                <button
                  onClick={() => { setDateFrom(""); setDateTo(""); }}
                  className="flex items-center gap-1 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-500 transition hover:bg-slate-50"
                >
                  <X className="h-3 w-3" />
                  Clear
                </button>
              )}

              <a
                href={exportDisabled ? undefined : exportHref}
                aria-disabled={exportDisabled}
                title={
                  exportDisabled
                    ? "No applications to export"
                    : "Download the current queue as CSV"
                }
                className={`flex items-center gap-1.5 rounded-2xl border px-3 py-2 text-xs font-semibold transition ${
                  exportDisabled
                    ? "pointer-events-none border-slate-200 bg-slate-50 text-slate-400"
                    : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                }`}
              >
                <Download className="h-3.5 w-3.5" />
                Export CSV
              </a>
            </div>
          </div>

          {/* Active filter summary badge */}
          {isFilterActive && (
            <div className="mt-3">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                <CalendarDays className="h-3 w-3" />
                {activeFilterLabel}
                <span className="mx-0.5 text-emerald-400">·</span>
                <span className="font-normal text-emerald-600">
                  {filtered.length} result{filtered.length !== 1 ? "s" : ""}
                </span>
              </span>
            </div>
          )}
        </div>

        {loading ? (
          <div className="px-6 py-12 text-sm text-slate-500">Loading dealer applications...</div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-12 text-sm text-slate-500">
            {isFilterActive
              ? `No applications found for ${activeFilterLabel}.`
              : query
                ? "No applications match your search."
                : "No dealer applications found."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80">
                  {["Dealer", "Company", "Sales Manager", "Documents", "Agreement", "Status", "Actions"].map((h, i, arr) => (
                    <th
                      key={h}
                      className={`px-6 py-4 text-xs font-semibold uppercase tracking-wide text-slate-500 ${i === arr.length - 1 ? "text-right" : "text-left"}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {filtered.map((item, index) => (
                  <motion.tr
                    key={item.dealerId}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.22, delay: index * 0.04 }}
                    className="border-b border-slate-100 transition hover:bg-slate-50/70"
                  >
                    <td className="px-6 py-5 align-top">
                      <p className="font-semibold text-slate-900">{item.dealerName}</p>
                      <p className="mt-1 text-sm text-slate-500">ID: {item.dealerId.slice(0, 8)}...</p>
                      {item.submittedAt && (
                        <p className="mt-1 text-xs text-slate-400">
                          Submitted:{" "}
                          {new Date(item.submittedAt).toLocaleDateString("en-IN", {
                            day: "numeric", month: "short", year: "numeric",
                          })}
                          {" · "}
                          {new Date(item.submittedAt).toLocaleTimeString("en-IN", {
                            hour: "numeric", minute: "2-digit", hour12: true,
                          })}
                        </p>
                      )}
                    </td>

                    <td className="px-6 py-5 align-top">
                      <p className="font-medium text-slate-800">
                        {item.companyName}
                        <DuplicateBadge flag={item.duplicateFlag} />
                      </p>
                      <p className="mt-1 text-sm text-slate-500">GST: {item.gstNumber || "Not available"}</p>
                      <p className="mt-1 text-sm capitalize text-slate-400">
                        {(item.companyType || "Not available").replaceAll("_", " ")}
                      </p>
                    </td>

                    <td className="px-6 py-5 align-top">
                      {item.salesManagerName ? (
                        <div className="flex items-start gap-2">
                          <div className="mt-0.5 rounded-xl bg-slate-50 p-1.5 text-slate-500">
                            <UserCog className="h-3.5 w-3.5" />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-slate-800">
                              {item.salesManagerName}
                            </p>
                            {item.salesManagerEmail && (
                              <p className="mt-0.5 truncate text-xs text-slate-500">
                                {item.salesManagerEmail}
                              </p>
                            )}
                            {item.salesManagerMobile && (
                              <p className="mt-0.5 truncate text-xs text-slate-400">
                                {item.salesManagerMobile}
                              </p>
                            )}
                          </div>
                        </div>
                      ) : (
                        <span className="text-sm text-slate-400">Not assigned</span>
                      )}
                    </td>

                    <td className="px-6 py-5 align-top">
                      <DocumentBadge value={item.documents} />
                    </td>

                    <td className="px-6 py-5 align-top">
                      <AgreementBadge value={item.agreement} />
                    </td>

                    <td className="px-6 py-5 align-top">
                      <StatusBadge status={item.status} />
                    </td>

                    <td className="px-6 py-5 text-right align-top">
                      <Link
                        href={`/admin/dealer-verification/${item.dealerId}`}
                        className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
                      >
                        Review
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </motion.div>
    </div>
  );
}
