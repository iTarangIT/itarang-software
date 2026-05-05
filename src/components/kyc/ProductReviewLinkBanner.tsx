"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Package, ArrowRight } from "lucide-react";

// BRD V2 §2.4 — once a finance dealer submits Step 4 the admin needs to act
// on the product selection (sanction / reject the loan). Those actions live
// at /admin/product-review/[leadId]. Surface a one-click banner from the KYC
// review page so the admin doesn't have to leave the case to find them.

interface ProductReviewSummary {
  leadStatus: string | null;
  selection: { id: string } | null;
  loanSanction: { status: string } | null;
}

const TRIGGER_STATES = new Set([
  "pending_final_approval",
  "loan_sanctioned",
  "loan_rejected",
]);

const STATE_COPY: Record<string, { label: string; tone: "amber" | "blue" | "red" }> = {
  pending_final_approval: {
    label: "Step 4 submitted — awaiting your loan decision",
    tone: "amber",
  },
  loan_sanctioned: {
    label: "Loan sanctioned — dealer is finalising dispatch",
    tone: "blue",
  },
  loan_rejected: {
    label: "Loan rejected — dealer is choosing next step",
    tone: "red",
  },
};

export default function ProductReviewLinkBanner({ leadId }: { leadId: string }) {
  const [summary, setSummary] = useState<ProductReviewSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/lead/${leadId}/product-selection`, {
          cache: "no-store",
        });
        const json = await res.json();
        if (!cancelled && json.success) setSummary(json.data);
      } catch {
        // non-fatal — banner just won't render
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [leadId]);

  if (!summary) return null;
  const status = summary.leadStatus || "";
  if (!TRIGGER_STATES.has(status)) return null;
  if (!summary.selection) return null;

  const copy = STATE_COPY[status];
  const tone = copy?.tone ?? "amber";
  const palette =
    tone === "blue"
      ? "from-blue-50 to-white border-blue-200 text-blue-900"
      : tone === "red"
        ? "from-red-50 to-white border-red-200 text-red-900"
        : "from-amber-50 to-white border-amber-200 text-amber-900";
  const iconBg =
    tone === "blue"
      ? "bg-blue-500"
      : tone === "red"
        ? "bg-red-500"
        : "bg-amber-500";

  return (
    <div
      className={`mb-5 flex items-center justify-between gap-4 rounded-2xl border bg-gradient-to-br ${palette} px-5 py-4 shadow-sm`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-10 h-10 rounded-xl ${iconBg} text-white flex items-center justify-center shadow-sm`}>
          <Package className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold leading-snug">{copy?.label ?? "Step 4 product selection"}</p>
          <p className="text-[11px] uppercase tracking-wider opacity-70">
            Status: {status.replace(/_/g, " ")}
          </p>
        </div>
      </div>
      <Link
        href={`/admin/product-review/${leadId}`}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white border border-current text-current text-sm font-bold hover:bg-gray-50 transition-colors flex-shrink-0"
      >
        Open Product Review
        <ArrowRight className="w-4 h-4" />
      </Link>
    </div>
  );
}
