"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Stage = "needs_inspection" | "refurbishable" | "ready_for_auction" | "resold" | "scrap";

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

interface Props {
  stages: Stage[];
  stageLabels: Record<Stage, string>;
  rows: Row[];
}

// BRD §6.1.7 — allowed stage transitions.
const ALLOWED_NEXT: Record<Stage, Stage[]> = {
  needs_inspection: ["refurbishable", "scrap"],
  refurbishable: ["ready_for_auction", "scrap"],
  ready_for_auction: ["resold", "refurbishable"],
  resold: [],
  scrap: [],
};

const STAGE_TONE: Record<Stage, string> = {
  needs_inspection: "bg-amber-50 border-amber-200",
  refurbishable: "bg-sky-50 border-sky-200",
  ready_for_auction: "bg-violet-50 border-violet-200",
  resold: "bg-emerald-50 border-emerald-200",
  scrap: "bg-slate-100 border-slate-200",
};

export default function RecoveryKanban({ stages, stageLabels, rows }: Props) {
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

  return (
    <>
      {error ? (
        <div className="bg-red-50 text-red-700 text-sm rounded p-3 mb-2">{error}</div>
      ) : null}

      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
        {stages.map((s) => (
          <div key={s} className={`border rounded-lg p-2 ${STAGE_TONE[s]}`}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-bold uppercase tracking-widest text-slate-700">
                {stageLabels[s]}
              </h3>
              <span className="text-xs tabular-nums text-slate-500">
                {rows.filter((r) => r.stage === s).length}
              </span>
            </div>
            <div className="space-y-2">
              {rows
                .filter((r) => r.stage === s)
                .map((r) => (
                  <Card
                    key={r.id}
                    row={r}
                    busy={busyId === r.id}
                    onMove={moveTo}
                    onImmobilise={() => setImmobiliseFor(r)}
                  />
                ))}
              {rows.filter((r) => r.stage === s).length === 0 ? (
                <p className="text-xs text-slate-400 italic px-1 py-2">Empty</p>
              ) : null}
            </div>
          </div>
        ))}
      </section>

      {immobiliseFor ? (
        <ImmobilisationRequestModal
          row={immobiliseFor}
          onClose={() => setImmobiliseFor(null)}
          onSuccess={() => {
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
    <div className="bg-white border border-slate-200 rounded-md p-2.5 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-[11px] text-slate-500">{row.battery_serial}</p>
          <p className="font-medium text-sm">{row.borrower_name ?? "—"}</p>
          <p className="text-[11px] text-slate-500">{row.loan_application_id ?? "—"}</p>
        </div>
        <div className="text-right">
          {row.live_soh_pct != null ? (
            <p className="text-[11px] font-bold text-slate-700 tabular-nums">
              SOH {Math.round(row.live_soh_pct)}%
            </p>
          ) : null}
          {row.estimated_recovery_value != null ? (
            <p className="text-[11px] text-emerald-700 tabular-nums">
              ₹{row.estimated_recovery_value.toLocaleString("en-IN")}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-500">
        <span>{row.age_days}d in stage</span>
        {row.current_dpd != null && row.current_dpd > 0 ? (
          <span className="px-1.5 py-0.5 rounded bg-red-50 text-red-700 font-bold">
            DPD {row.current_dpd}
          </span>
        ) : null}
      </div>

      {next.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {next.map((n) => (
            <button
              key={n}
              disabled={busy}
              onClick={() => onMove(row.id, n)}
              className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest rounded border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              → {n.replace(/_/g, " ")}
            </button>
          ))}
        </div>
      ) : null}

      {row.imei && row.loan_application_id ? (
        <button
          onClick={onImmobilise}
          disabled={busy}
          className="mt-2 w-full px-2 py-1 text-[10px] font-bold uppercase tracking-widest rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
        >
          Initiate immobilisation
        </button>
      ) : null}
    </div>
  );
}

function ImmobilisationRequestModal({
  row,
  onClose,
  onSuccess,
}: {
  row: Row;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [reason, setReason] = useState<"dpd_60" | "dpd_90" | "fraud_flag" | "manual">("manual");
  const [imei, setImei] = useState(row.imei ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!row.loan_application_id || !imei.trim()) {
      setError("Loan and IMEI are both required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/nbfc/actions/battery-immobilisation/initiate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          loan_application_id: row.loan_application_id,
          imei: imei.trim(),
          reason_code: reason,
          reviewed_evidence_ack: true,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 space-y-4">
        <div>
          <h3 className="text-lg font-bold">Initiate immobilisation</h3>
          <p className="text-sm text-slate-500">
            iTarang sales_head must approve before the device is immobilised.
          </p>
        </div>

        <dl className="text-sm space-y-1 bg-slate-50 rounded p-3">
          <Row2 k="Borrower" v={row.borrower_name ?? "—"} />
          <Row2 k="Loan" v={row.loan_application_id ?? "—"} />
          <Row2 k="Battery" v={row.battery_serial} />
          {row.current_dpd != null ? <Row2 k="DPD" v={`${row.current_dpd}d`} /> : null}
          {row.outstanding_amount != null ? (
            <Row2 k="Outstanding" v={`₹${row.outstanding_amount.toLocaleString("en-IN")}`} />
          ) : null}
        </dl>

        <div>
          <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1">
            IMEI
          </label>
          <input
            value={imei}
            onChange={(e) => setImei(e.target.value)}
            disabled={busy}
            className="w-full border border-slate-300 rounded px-2 py-1 text-sm font-mono"
          />
        </div>

        <div>
          <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1">
            Reason
          </label>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as typeof reason)}
            disabled={busy}
            className="w-full border border-slate-300 rounded px-2 py-1 text-sm"
          >
            <option value="dpd_60">DPD ≥ 60</option>
            <option value="dpd_90">DPD ≥ 90</option>
            <option value="fraud_flag">Fraud flag</option>
            <option value="manual">Manual</option>
          </select>
        </div>

        {error ? <div className="bg-red-50 text-red-700 text-xs rounded p-2">{error}</div> : null}

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-1.5 text-sm font-bold text-slate-600 hover:text-slate-900"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="px-4 py-1.5 text-sm font-bold rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? "Submitting…" : "Send to sales_head"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row2({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-slate-500">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}
