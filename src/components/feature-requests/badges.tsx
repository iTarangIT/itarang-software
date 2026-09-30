"use client";

import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import { STATUS_LABELS, type Status } from "@/lib/feature-requests/workflow";

const STATUS_STYLES: Record<Status, string> = {
  pending_product_review: "bg-amber-50 text-amber-700 ring-amber-200",
  pending_tech_review: "bg-amber-50 text-amber-700 ring-amber-200",
  changes_requested: "bg-orange-50 text-orange-700 ring-orange-200",
  rejected: "bg-red-50 text-red-700 ring-red-200",
  ready_for_assignment: "bg-sky-50 text-sky-700 ring-sky-200",
  assigned: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  in_development: "bg-violet-50 text-violet-700 ring-violet-200",
  testing: "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200",
  ready_for_deployment: "bg-teal-50 text-teal-700 ring-teal-200",
  deployed: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  closed: "bg-gray-100 text-gray-600 ring-gray-200",
};

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset whitespace-nowrap",
        STATUS_STYLES[status] ?? "bg-gray-100 text-gray-600 ring-gray-200",
      )}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

const PRIORITY_STYLES: Record<string, string> = {
  low: "bg-gray-100 text-gray-600",
  medium: "bg-blue-50 text-blue-700",
  high: "bg-orange-50 text-orange-700",
  critical: "bg-red-600 text-white",
};

export function PriorityBadge({ priority }: { priority: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide",
        PRIORITY_STYLES[priority] ?? PRIORITY_STYLES.low,
      )}
    >
      {priority}
    </span>
  );
}

/** The happy path, with the current step highlighted. */
const STEPS: { label: string; statuses: Status[] }[] = [
  { label: "Product Review", statuses: ["pending_product_review"] },
  { label: "Tech Review", statuses: ["pending_tech_review"] },
  { label: "Assignment", statuses: ["ready_for_assignment"] },
  { label: "Assigned", statuses: ["assigned"] },
  { label: "Development", statuses: ["in_development"] },
  { label: "Testing", statuses: ["testing"] },
  { label: "Ready to Deploy", statuses: ["ready_for_deployment"] },
  { label: "Deployed", statuses: ["deployed"] },
  { label: "Closed", statuses: ["closed"] },
];

export function StatusStepper({
  status,
  resubmitTo,
}: {
  status: Status;
  resubmitTo: Status | null;
}) {
  // A sent-back request sits at the stage it will return to.
  const effective = status === "changes_requested" ? (resubmitTo ?? "pending_product_review") : status;
  const current = STEPS.findIndex((s) => s.statuses.includes(effective));
  const off = status === "rejected" || status === "changes_requested";

  return (
    <ol className="flex flex-wrap items-center gap-y-2">
      {STEPS.map((s, i) => {
        const done = current >= 0 && (i < current || effective === "closed");
        const active = i === current && effective !== "closed";
        return (
          <li key={s.label} className="flex items-center">
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold",
                done && "bg-emerald-50 text-emerald-700",
                active && !off && "bg-blue-600 text-white",
                active && off && "bg-orange-100 text-orange-700 ring-1 ring-orange-300",
                !done && !active && "bg-gray-50 text-gray-400",
              )}
            >
              {done && <Check className="h-3 w-3" />}
              {s.label}
            </span>
            {i < STEPS.length - 1 && <span className="mx-1 h-px w-3 bg-gray-200" />}
          </li>
        );
      })}
    </ol>
  );
}
