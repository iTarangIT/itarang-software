"use client";

import { useOnboardingStore } from "@/store/onboardingStore";

const STATUS_MAP: Record<
  string,
  { label: string; classes: string }
> = {
  draft:         { label: "Draft",        classes: "bg-slate-100 text-slate-600" },
  in_progress:   { label: "In Progress",  classes: "bg-blue-50 text-blue-700" },
  submitted:     { label: "Submitted",    classes: "bg-amber-50 text-amber-700" },
  under_review:  { label: "Under Review", classes: "bg-indigo-50 text-indigo-700" },
  action_needed: { label: "Action Needed",classes: "bg-orange-50 text-orange-700" },
  approved:      { label: "Approved",     classes: "bg-emerald-50 text-emerald-700" },
};

export default function AutosaveStatus() {
  const lastSavedAt = useOnboardingStore((s) => s.lastSavedAt);
  const status = useOnboardingStore((s) => s.status);

  const mapped = STATUS_MAP[status] ?? { label: status, classes: "bg-slate-100 text-slate-600" };

  const savedLabel = lastSavedAt
    ? `Saved • ${new Date(lastSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : "Saving...";

  return (
    <div className="flex items-center gap-3 flex-wrap justify-end">
      <span className="flex items-center gap-1.5 text-sm text-slate-400">
        {lastSavedAt ? (
          <>
            <svg className="h-3.5 w-3.5 text-emerald-500" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
            </svg>
            {savedLabel}
          </>
        ) : (
          <>
            <svg className="h-3.5 w-3.5 animate-spin text-slate-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 2a6 6 0 1 0 6 6" strokeLinecap="round" />
            </svg>
            Saving...
          </>
        )}
      </span>

      <span className={`px-3 py-1 rounded-full text-xs font-semibold ${mapped.classes}`}>
        {mapped.label}
      </span>
    </div>
  );
}