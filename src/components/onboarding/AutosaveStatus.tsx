"use client";

import { useOnboardingStore } from "@/store/onboardingStore";

export default function AutosaveStatus() {
  const lastSavedAt = useOnboardingStore((s) => s.lastSavedAt);
  const status = useOnboardingStore((s) => s.status);

  const statusMap = {
    draft: "Draft",
    in_progress: "In Progress",
    under_review: "Under Review",
    action_needed: "Action Needed",
    approved: "Approved",
  };

  return (
    <div className="flex items-center gap-3 flex-wrap justify-end">
      <span className="text-sm text-slate-500">
        {lastSavedAt ? `Saved ✓ • ${new Date(lastSavedAt).toLocaleTimeString()}` : "Saving..."}
      </span>
      <span className="px-3 py-1 rounded-full text-sm font-semibold bg-slate-100 text-slate-700">
        {statusMap[status]}
      </span>
    </div>
  );
}