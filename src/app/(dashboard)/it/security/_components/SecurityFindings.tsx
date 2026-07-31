"use client";

import { useState } from "react";
import type { Severity } from "@/lib/security/severity";
import type { SecurityCategory } from "@/lib/security/types";
import FindingCard from "./FindingCard";
import FindingDrawer from "./FindingDrawer";

export interface FindingForUi {
  id: string;
  check_slug: string;
  category: SecurityCategory;
  severity: Severity;
  title: string;
  summary: string;
  target_url: string;
  http_method: string | null;
  evidence_json: Record<string, unknown> | null;
  reproduction: string | null;
  remediation: string | null;
  owasp_ref: string | null;
  cwe_ref: string | null;
  confidence: string;
  status: string;
  created_at: string | null;
  resolution_summary: string | null;
  resolution_report: Record<string, unknown> | null;
  resolution_method: string | null;
}

export default function SecurityFindings({ findings }: { findings: FindingForUi[] }) {
  const [open, setOpen] = useState<FindingForUi | null>(null);

  if (findings.length === 0) {
    return (
      <div className="text-center text-sm text-slate-500 py-16 border border-dashed border-slate-300 dark:border-slate-700 rounded-lg">
        No findings match the current filters. Run a scan or clear the filters.
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {findings.map((f) => (
          <FindingCard key={f.id} finding={f} onOpen={() => setOpen(f)} />
        ))}
      </div>
      {open && <FindingDrawer finding={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
