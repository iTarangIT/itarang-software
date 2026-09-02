"use client";

/**
 * E-280 — sales invoices the Drive scan could not fully handle.
 *
 * Two different problems, deliberately shown apart, because conflating them
 * told an admin the wrong thing on the expense side and would here too:
 *
 *   FILES that never became an invoice — unreadable, unsupported, or the scan
 *   failed on them. Their value is MISSING from revenue, and somebody has to
 *   act or the CEO's number is quietly short.
 *
 *   INVOICES that imported but look wrong — a date that disagrees with the
 *   folder it was filed in, arithmetic that does not add up, an entity the
 *   signals disagreed on, or a possible duplicate of an invoice already
 *   recorded. These ARE counted in revenue; they just want a human's eye.
 *
 * Renders nothing when both lists are empty, so a healthy setup costs no screen.
 */

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, FileWarning, Loader2 } from "lucide-react";

interface AttentionFile {
  id: string;
  drive_file_id: string;
  drive_file_name: string | null;
  folder_path: string | null;
  status: string;
  reason: string | null;
  created_at: string;
}

interface FlaggedInvoice {
  id: string;
  invoice_number: string | null;
  customer_name: string | null;
  invoice_date: string | null;
  total: string | null;
  folder_path: string | null;
  document_url: string | null;
  attention_reason: string | null;
}

const INR = (v: string | null) =>
  v == null ? "—" : `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** Drive has no stored link, but a file id is enough to build one. */
function driveLink(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

export function SalesScanAttentionPanel() {
  const { data: files, isLoading: loadingFiles } = useQuery({
    queryKey: ["sales-runs", "attention"],
    queryFn: async () => {
      const r = await fetch("/api/admin/sales-invoices/drive/runs?view=attention", {
        cache: "no-store",
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j?.error?.message || "Failed to load");
      return (j.data?.files || []) as AttentionFile[];
    },
  });

  const { data: invoices, isLoading: loadingInvoices } = useQuery({
    queryKey: ["sales-runs", "flagged-invoices"],
    queryFn: async () => {
      const r = await fetch("/api/admin/sales-invoices/drive/runs?view=invoices", {
        cache: "no-store",
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j?.error?.message || "Failed to load");
      return (j.data?.invoices || []) as FlaggedInvoice[];
    },
  });

  const unreadable = files ?? [];
  const flagged = invoices ?? [];

  if (loadingFiles || loadingInvoices) {
    return (
      <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
        <p className="text-xs text-gray-500 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking sales imports…
        </p>
      </div>
    );
  }

  if (unreadable.length + flagged.length === 0) return null;

  return (
    <div
      className="p-6 rounded-2xl bg-white border border-amber-200 shadow-sm space-y-6"
      data-testid="sales-attention-panel"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-600" />
        <h2 className="text-sm font-semibold text-gray-900">Sales invoices needing a look</h2>
      </div>

      {unreadable.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
            Not imported — missing from revenue ({unreadable.length})
          </p>
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100">
            {unreadable.map((f) => (
              <li key={f.id} className="px-4 py-3" data-testid="sales-attention-file">
                <div className="flex flex-wrap items-center gap-2">
                  <FileWarning className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                  <a
                    href={driveLink(f.drive_file_id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-brand-700 hover:underline inline-flex items-center gap-1"
                  >
                    {f.drive_file_name || f.drive_file_id}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                  <span className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 text-[10px] font-bold uppercase tracking-wider">
                    {f.status}
                  </span>
                </div>
                {f.folder_path && (
                  <p className="text-[11px] text-gray-500 mt-0.5">{f.folder_path}</p>
                )}
                <p className="text-xs text-gray-600 mt-1">{f.reason || "Unknown problem."}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {flagged.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
            Imported and counted, but worth checking ({flagged.length})
          </p>
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100">
            {flagged.map((inv) => (
              <li key={inv.id} className="px-4 py-3" data-testid="sales-attention-invoice">
                <div className="flex flex-wrap items-baseline gap-2">
                  {inv.document_url ? (
                    <a
                      href={inv.document_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-brand-700 hover:underline"
                    >
                      {inv.invoice_number || "(no number)"}
                    </a>
                  ) : (
                    <span className="text-sm font-medium text-gray-900">
                      {inv.invoice_number || "(no number)"}
                    </span>
                  )}
                  <span className="text-xs text-gray-600">{inv.customer_name || "—"}</span>
                  <span className="text-xs text-gray-500">{inv.invoice_date || "—"}</span>
                  <span className="text-xs font-semibold text-gray-900 ml-auto">
                    {INR(inv.total)}
                  </span>
                </div>
                {inv.folder_path && (
                  <p className="text-[11px] text-gray-500 mt-0.5">{inv.folder_path}</p>
                )}
                <p className="text-xs text-amber-800 mt-1">{inv.attention_reason}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
