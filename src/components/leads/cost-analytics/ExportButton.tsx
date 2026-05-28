// Triggers the CSV download via window.location so the browser handles
// the file save dialog. Keeps the same filter set as the active view by
// serializing the filters object identically to the GET API.

"use client";

import { Download } from "lucide-react";
import type { CostAnalyticsFilters } from "./types";

function buildExportQuery(filters: CostAnalyticsFilters): string {
  const params = new URLSearchParams();
  if (filters.from_date) params.set("from_date", filters.from_date);
  if (filters.to_date) params.set("to_date", filters.to_date);
  if (filters.provider) params.set("provider", filters.provider);
  if (filters.campaign_id) params.set("campaign_id", filters.campaign_id);
  return params.toString();
}

export function ExportButton({
  filters,
  disabled,
}: {
  filters: CostAnalyticsFilters;
  disabled?: boolean;
}) {
  const handle = () => {
    const qs = buildExportQuery(filters);
    window.location.href = `/api/campaigns/cost-analytics/export${qs ? `?${qs}` : ""}`;
  };

  return (
    <button
      onClick={handle}
      disabled={disabled}
      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-gray-900 text-white rounded-lg hover:bg-gray-700 transition-colors shadow-sm disabled:opacity-50"
    >
      <Download className="w-3.5 h-3.5" />
      Export CSV
    </button>
  );
}
