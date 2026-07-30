"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { SEVERITIES, SEVERITY_LABELS } from "@/lib/security/severity";

/** Server-driven filters (severity/category/status) — kept in the URL so exports match the view. */
export default function FilterBar({
  categories,
}: {
  categories: Array<{ value: string; label: string }>;
}) {
  const router = useRouter();
  const params = useSearchParams();

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`/it/security?${next.toString()}`);
  };

  const sel =
    "text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className={sel} value={params.get("severity") ?? ""} onChange={(e) => set("severity", e.target.value)}>
        <option value="">All severities</option>
        {SEVERITIES.map((s) => (
          <option key={s} value={s}>
            {SEVERITY_LABELS[s]}
          </option>
        ))}
      </select>

      <select className={sel} value={params.get("category") ?? ""} onChange={(e) => set("category", e.target.value)}>
        <option value="">All categories</option>
        {categories.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>

      <select className={sel} value={params.get("status") ?? ""} onChange={(e) => set("status", e.target.value)}>
        <option value="">Active (open + acknowledged)</option>
        <option value="open">Open</option>
        <option value="acknowledged">Acknowledged</option>
        <option value="resolved">Resolved</option>
        <option value="false_positive">False positive</option>
      </select>
    </div>
  );
}
