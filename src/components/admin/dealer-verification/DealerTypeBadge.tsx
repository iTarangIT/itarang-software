"use client";

import { dealerTypeLabel, normalizeDealerType } from "@/lib/dealer/dealer-type";

// E-202 dealer business type badge, shared by the verification queue and the
// detail review page so both read the same wording and colours. Colour-coded so
// an admin can tell the three apart at a glance while scanning the queue; a
// pre-E-202 application (dealer_type NULL) renders a muted "Not specified"
// rather than disappearing, so a missing value is visible instead of silent.

const TONE: Record<string, string> = {
  new: "border-blue-200 bg-blue-50 text-blue-700",
  scrap: "border-amber-200 bg-amber-50 text-amber-700",
  both: "border-violet-200 bg-violet-50 text-violet-700",
};

const UNKNOWN_TONE = "border-slate-200 bg-slate-50 text-slate-500";

export default function DealerTypeBadge({
  value,
  className = "",
}: {
  value?: string | null;
  className?: string;
}) {
  const key = normalizeDealerType(value);
  const tone = key ? TONE[key] : UNKNOWN_TONE;

  return (
    <span
      title={
        key
          ? "Dealer business type — selected by the dealer during onboarding. Determines which agreement template is used."
          : "This application was submitted before dealer type was captured."
      }
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone} ${className}`}
    >
      {dealerTypeLabel(value)}
    </span>
  );
}
