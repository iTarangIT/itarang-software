"use client";

/**
 * RecoveryKanban — BRD §6.1.7 recovery stage board.
 *
 * Stage transitions enforce the §6.1.7 SOH guardrail (a battery may only be
 * marked Refurbishable when SOH exceeds 70%). The "Request immobilisation"
 * action routes through ImmobilisationRequestDialog, which renders the
 * mandatory §6.1.6 Borrower Notice Preview (5 elements + reversibility +
 * "I confirm" gate) before any request can be submitted.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import ImmobilisationRequestDialog from "@/components/nbfc-portal/ImmobilisationRequestDialog";
import type { BorrowerNoticeContent } from "@/components/nbfc-portal/BorrowerNoticePreview";

type Stage =
  | "needs_inspection"
  | "refurbishable"
  | "ready_for_auction"
  | "resold"
  | "scrap";

interface Row {
  id: string;
  battery_serial: string;
  stage: Stage;
  estimated_recovery_value: number | null;
  borrower_name: string | null;
  loan_application_id: string | null;
  current_dpd: number | null;
  outstanding_amount: number | null;
  imei: string | null;
  live_soh_pct: number | null;
  age_days: number;
}

interface TenantLegal {
  legal_name: string | null;
  display_name: string;
  grievance_url: string | null;
  grievance_helpline: string | null;
}

interface Props {
  stages: Stage[];
  stageLabels: Record<Stage, string>;
  rows: Row[];
  tenantLegal: TenantLegal;
}

// BRD §6.1.7 — allowed stage transitions.
const ALLOWED_NEXT: Record<Stage, Stage[]> = {
  needs_inspection: ["refurbishable", "scrap"],
  refurbishable: ["ready_for_auction", "scrap"],
  ready_for_auction: ["resold", "refurbishable"],
  resold: [],
  scrap: [],
};

// BRD §6.1.7 — a battery may only enter Refurbishable above this SOH.
const REFURBISHABLE_MIN_SOH = 70;

const STAGE_TONE: Record<Stage, string> = {
  needs_inspection: "bg-amber-50 border-amber-200",
  refurbishable: "bg-sky-50 border-sky-200",
  ready_for_auction: "bg-violet-50 border-violet-200",
  resold: "bg-emerald-50 border-emerald-200",
  scrap: "bg-slate-100 border-slate-200",
};

export default function RecoveryKanban({
  stages,
  stageLabels,
  rows,
  tenantLegal,
}: Props) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [immobiliseFor, setImmobiliseFor] = useState<Row | null>(null);

  async function moveTo(rowId: string, target: Stage) {
    setBusyId(rowId);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/recovery/${rowId}/stage`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stage: target }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusyId(null);
    }
  }

  const notice: BorrowerNoticeContent | null = immobiliseFor
    ? {
        lender_legal_name:
          tenantLegal.legal_name ?? tenantLegal.display_name,
        outstanding_amount: immobiliseFor.outstanding_amount ?? 0,
        restoration_steps:
          "Pay the outstanding EMI amount to restore battery mobility — service is re-mobilised within 2 hours of settlement.",
        grievance_url:
          tenantLegal.grievance_url ?? "https://itarang.com/grievance",
        helpline: tenantLegal.grievance_helpline ?? "1800-000-0000",
      }
    : null;

  return (
    <>
      {error ? (
        <div className="mb-2 rounded bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {stages.map((s) => {
          const laneRows = rows.filter((r) => r.stage === s);
          return (
            <div key={s} className={`rounded-lg border p-2 ${STAGE_TONE[s]}`}>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-700">
                  {stageLabels[s]}
                </h3>
                <span className="text-xs tabular-nums text-slate-500">
                  {laneRows.length}
                </span>
              </div>
              <div className="space-y-2">
                {laneRows.map((r) => (
                  <Card
                    key={r.id}
                    row={r}
                    busy={busyId === r.id}
                    onMove={moveTo}
                    onImmobilise={() => setImmobiliseFor(r)}
                  />
                ))}
                {laneRows.length === 0 ? (
                  <p className="px-1 py-2 text-xs italic text-slate-400">
                    Empty
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </section>

      {immobiliseFor && notice && immobiliseFor.loan_application_id ? (
        <ImmobilisationRequestDialog
          loanSanctionId={immobiliseFor.loan_application_id}
          notice={notice}
          open
          onClose={() => setImmobiliseFor(null)}
          onRequested={() => {
            setImmobiliseFor(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

function Card({
  row,
  busy,
  onMove,
  onImmobilise,
}: {
  row: Row;
  busy: boolean;
  onMove: (id: string, stage: Stage) => void;
  onImmobilise: () => void;
}) {
  const next = ALLOWED_NEXT[row.stage];
  return (
    <div className="rounded-md border border-slate-200 bg-white p-2.5 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[11px] text-slate-500">
            {row.battery_serial}
          </p>
          <p className="truncate text-sm font-medium">
            {row.borrower_name ?? "—"}
          </p>
          <p className="truncate text-[11px] text-slate-500">
            {row.loan_application_id ?? "—"}
          </p>
        </div>
        <div className="text-right">
          {row.live_soh_pct != null ? (
            <p className="text-[11px] font-bold tabular-nums text-slate-700">
              SOH {Math.round(row.live_soh_pct)}%
            </p>
          ) : null}
          {row.estimated_recovery_value != null ? (
            <p className="text-[11px] tabular-nums text-emerald-700">
              ₹{row.estimated_recovery_value.toLocaleString("en-IN")}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-500">
        <span>{row.age_days}d in stage</span>
        {row.current_dpd != null && row.current_dpd > 0 ? (
          <span className="rounded bg-red-50 px-1.5 py-0.5 font-bold text-red-700">
            DPD {row.current_dpd}
          </span>
        ) : null}
      </div>

      {next.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {next.map((n) => {
            // BRD §6.1.7 — Refurbishable requires SOH > 70%.
            const blocked =
              n === "refurbishable" &&
              row.live_soh_pct != null &&
              row.live_soh_pct <= REFURBISHABLE_MIN_SOH;
            return (
              <button
                key={n}
                disabled={busy || blocked}
                title={
                  blocked
                    ? `SOH must exceed ${REFURBISHABLE_MIN_SOH}% to mark Refurbishable (BRD §6.1.7)`
                    : undefined
                }
                onClick={() => onMove(row.id, n)}
                className="rounded border border-slate-300 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                → {n.replace(/_/g, " ")}
              </button>
            );
          })}
        </div>
      ) : null}

      {row.imei && row.loan_application_id ? (
        <button
          onClick={onImmobilise}
          disabled={busy}
          className="mt-2 w-full rounded bg-red-600 px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-white hover:bg-red-700 disabled:opacity-50"
        >
          Request immobilisation
        </button>
      ) : null}
    </div>
  );
}
