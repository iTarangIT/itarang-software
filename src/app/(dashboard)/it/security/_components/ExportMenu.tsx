"use client";

import { useSearchParams } from "next/navigation";
import { Download } from "lucide-react";

/** Download links carrying the active filters, so an export matches the on-screen view. */
export default function ExportMenu() {
  const params = useSearchParams();
  const qs = params.toString();
  const suffix = qs ? `?${qs}` : "";

  const links: Array<{ label: string; href: string }> = [
    { label: "Excel", href: `/api/it/security/report/export.xlsx${suffix}` },
    { label: "PDF", href: `/api/it/security/report/pdf${suffix}` },
    { label: "Word", href: `/api/it/security/report/docx${suffix}` },
  ];

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-slate-500 inline-flex items-center gap-1">
        <Download className="h-3.5 w-3.5" /> Report:
      </span>
      {links.map((l) => (
        <a
          key={l.label}
          href={l.href}
          className="text-xs font-medium px-2.5 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          {l.label}
        </a>
      ))}
    </div>
  );
}
