"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Building2,
  Clock3,
  FileCheck2,
  Search,
  ShieldCheck,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";

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

  const classes =
    map[status] || "bg-slate-50 text-slate-700 border-slate-200";

  return (
    <span
      className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold capitalize ${classes}`}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}

function AgreementBadge({ value }: { value: string }) {
  const normalized = value?.toLowerCase();

  if (normalized === "required") {
    return (
      <span className="inline-flex rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
        Required
      </span>
    );
  }

  if (normalized === "signed") {
    return (
      <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
        Signed
      </span>
    );
  }

  return (
    <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
      {value || "N/A"}
    </span>
  );
}

function DocumentBadge({ value }: { value: string }) {
  const lower = value.toLowerCase();

  const classes = lower.includes("pending")
    ? "border-amber-200 bg-amber-50 text-amber-700"
    : lower.includes("/")
    ? "border-blue-200 bg-blue-50 text-blue-700"
    : "border-slate-200 bg-slate-50 text-slate-700";

  return (
    <span
      className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${classes}`}
    >
      {value}
    </span>
  );
}

export default function DealerVerificationPage() {
  const [applications, setApplications] = useState<DealerVerificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const loadApplications = async () => {
      try {
        const res = await fetch("/api/admin/dealer-verifications");
        const data = await res.json();

        if (data.success) {
          setApplications(data.applications || []);
        }
      } catch (error) {
        console.error("Failed to load dealer verifications", error);
      } finally {
        setLoading(false);
      }
    };

    loadApplications();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return applications;

    return applications.filter((item) =>
      [
        item.dealerName,
        item.companyName,
        item.gstNumber || "",
        item.status,
        item.companyType || "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [applications, query]);

  const stats = useMemo(() => {
    const total = applications.length;
    const pending = applications.filter((a) =>
      ["submitted", "pending_admin_review", "under_review"].includes(a.status)
    ).length;
    const approved = applications.filter((a) =>
      ["approved", "completed", "succeed"].includes(a.status)
    ).length;
    const correction = applications.filter((a) =>
      ["under_correction", "correction_requested"].includes(a.status)
    ).length;

    return { total, pending, approved, correction };
  }, [applications]);

  return (
    <div className="space-y-8 px-1">
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
              Review dealer onboarding submissions, validate documents and agreement flow,
              and activate approved dealer accounts with a controlled compliance workflow.
            </p>
          </div>

          <div className="relative w-full lg:w-[360px]">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search dealer, GST, company type, status..."
              className="h-12 w-full rounded-2xl border border-slate-200 bg-slate-50 pl-11 pr-4 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:bg-white"
            />
          </div>
        </div>
      </motion.div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Total Applications"
          value={stats.total}
          subtitle="All onboarding submissions"
          icon={<Building2 className="h-5 w-5" />}
        />
        <StatCard
          title="Pending Review"
          value={stats.pending}
          subtitle="Waiting for admin action"
          icon={<Clock3 className="h-5 w-5" />}
        />
        <StatCard
          title="Approved"
          value={stats.approved}
          subtitle="Dealer accounts activated"
          icon={<CheckCircle2 className="h-5 w-5" />}
        />
        <StatCard
          title="Correction Cases"
          value={stats.correction}
          subtitle="Need dealer clarification"
          icon={<ShieldCheck className="h-5 w-5" />}
        />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32 }}
        className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-5">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">
              Applications Queue
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Pending admin review, correction cases, and approval actions.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="px-6 py-12 text-sm text-slate-500">
            Loading dealer applications...
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-12 text-sm text-slate-500">
            No dealer applications found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80">
                  <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Dealer
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Company
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Documents
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Agreement
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Status
                  </th>
                  <th className="px-6 py-4 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Actions
                  </th>
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
                      <div>
                        <p className="font-semibold text-slate-900">{item.dealerName}</p>
                        <p className="mt-1 text-sm text-slate-500">
                          ID: {item.dealerId.slice(0, 8)}...
                        </p>
                      </div>
                    </td>

                    <td className="px-6 py-5 align-top">
                      <div>
                        <p className="font-medium text-slate-800">{item.companyName}</p>
                        <p className="mt-1 text-sm text-slate-500">
                          GST: {item.gstNumber || "Not available"}
                        </p>
                        <p className="mt-1 text-sm capitalize text-slate-400">
                          {(item.companyType || "Not available").replaceAll("_", " ")}
                        </p>
                      </div>
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