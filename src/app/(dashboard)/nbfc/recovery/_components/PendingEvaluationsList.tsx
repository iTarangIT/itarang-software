"use client";

/**
 * BRD §6.1.7 — Battery Evaluations entry point on /nbfc/recovery.
 *
 * Lists pipeline rows currently in `needs_inspection` and opens the existing
 * BatteryEvaluationWizard in a modal. On wizard completion the page is
 * router.refresh()'d so the pipeline stage changes flow back into the kanban
 * and KPI strip.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { BatteryEvaluationWizard } from "@/components/nbfc-portal/BatteryEvaluationWizard";

export interface PendingEvaluationRow {
  id: string;
  battery_serial: string;
  borrower_name: string | null;
  live_soh_pct: number | null;
  age_days: number;
}

interface Props {
  rows: PendingEvaluationRow[];
}

export default function PendingEvaluationsList({ rows }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const router = useRouter();

  return (
    <>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs uppercase tracking-widest text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left font-bold">Battery serial</th>
            <th className="px-3 py-2 text-left font-bold">Borrower</th>
            <th className="px-3 py-2 text-right font-bold">Live SOH</th>
            <th className="px-3 py-2 text-right font-bold">Age in stage</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-3 py-8 text-center text-slate-500">
                No batteries awaiting inspection.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-3 py-2 font-mono text-xs">{r.battery_serial}</td>
                <td className="px-3 py-2">{r.borrower_name ?? "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.live_soh_pct != null ? `${Math.round(r.live_soh_pct)}%` : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-xs text-slate-500">
                  {r.age_days}d
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => setOpenId(r.id)}
                    className="px-3 py-1 text-xs font-bold uppercase tracking-widest rounded bg-[color:var(--color-brand-navy)] text-white hover:opacity-90"
                  >
                    Start evaluation
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {openId ? (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="max-w-2xl w-full max-h-[90vh] overflow-y-auto bg-white dark:bg-slate-900 rounded-lg p-6 space-y-4 shadow-xl border border-slate-200 dark:border-slate-800">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="section-label-muted">BRD §6.1.7</p>
                <h3 className="text-lg font-semibold mt-1">Battery evaluation</h3>
              </div>
              <button
                type="button"
                onClick={() => setOpenId(null)}
                className="text-xs font-bold uppercase tracking-widest text-slate-500 hover:text-slate-900"
              >
                ✕ Cancel
              </button>
            </div>
            <BatteryEvaluationWizard
              recoveryPipelineId={openId}
              onComplete={() => {
                setOpenId(null);
                router.refresh();
              }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
