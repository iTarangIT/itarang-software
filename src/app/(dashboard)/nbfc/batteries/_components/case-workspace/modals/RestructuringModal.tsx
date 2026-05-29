"use client";

import { useState } from "react";
import { ModalShell } from "./ModalShell";
import AuditTrailPreview from "../AuditTrailPreview";

interface Props {
  open: boolean;
  onClose: () => void;
  loanApplicationId: string;
  batteryCode: string;
  borrowerName: string | null;
  currentEmiAmount: number | null;
  currentTenureMonths: number | null;
  currentEmiDueDom: number | null;
  outstanding: number | null;
  lenderLegalName: string;
  grievanceUrl: string;
  helpline: string;
  onSubmitted: () => void;
}

const REASON_OPTIONS = [
  "Force majeure (documented)",
  "Sustained EMI drop with cooperation",
  "Asset under repair — temporary",
  "Hardship — medical / employment",
];

export function RestructuringModal({
  open,
  onClose,
  loanApplicationId,
  batteryCode,
  borrowerName,
  currentEmiAmount,
  currentTenureMonths,
  currentEmiDueDom,
  outstanding,
  lenderLegalName,
  grievanceUrl,
  helpline,
  onSubmitted,
}: Props) {
  const [reason, setReason] = useState<string>("");
  const [newEmi, setNewEmi] = useState<string>(
    currentEmiAmount != null ? String(Math.round(currentEmiAmount * 0.8)) : "",
  );
  const [newTenure, setNewTenure] = useState<string>(
    currentTenureMonths != null
      ? String(currentTenureMonths + 6)
      : "",
  );
  const [newDueDom, setNewDueDom] = useState<string>(
    currentEmiDueDom != null ? String(currentEmiDueDom) : "5",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const newEmiNum = Number(newEmi);
  const newTenureNum = Number(newTenure);
  const newDueNum = Number(newDueDom);
  const canSubmit =
    reason.length > 0 &&
    Number.isFinite(newEmiNum) &&
    newEmiNum > 0 &&
    Number.isInteger(newTenureNum) &&
    newTenureNum > 0 &&
    Number.isInteger(newDueNum) &&
    newDueNum >= 1 &&
    newDueNum <= 28;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        "/api/nbfc/actions/loan-restructuring/initiate",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            loan_application_id: loanApplicationId,
            new_emi_amount: newEmiNum,
            new_tenure_months: newTenureNum,
            new_emi_due_dom: newDueNum,
            reason_code: reason,
            reviewed_evidence_ack: true,
          }),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        setError(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
        return;
      }
      onSubmitted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const formattedOutstanding =
    outstanding != null ? `₹${outstanding.toLocaleString("en-IN")}` : "the overdue amount";

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="You are about to initiate a loan restructuring review"
      caseSubtitle={`${batteryCode} · ${borrowerName ?? "—"}`}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border border-[color:var(--color-border)] px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit || submitting}
            className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
          >
            {submitting ? "Submitting…" : "Submit for approval"}
          </button>
        </>
      }
    >
      <section>
        <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
          What will happen
        </p>
        <ol className="ml-1 list-decimal space-y-1 pl-5 text-sm">
          <li>Request routed to Risk Head for first-pass review</li>
          <li>Ops Lead confirms eligibility + compliance approvals</li>
          <li>On approval, tenure / EMI schedule updated; borrower notified with new repayment schedule</li>
        </ol>
      </section>

      <section className="rounded-lg border border-sky-200 bg-sky-50/60 p-3">
        <p className="text-[10px] font-bold uppercase tracking-widest text-sky-700">
          🛡 Approvals required
        </p>
        <ul className="mt-1 space-y-0.5 text-sm">
          <li>
            <span className="font-semibold">Risk Head</span> · ~4 hrs
          </li>
          <li>
            <span className="font-semibold">Ops Lead</span> · ~24 hrs
          </li>
        </ul>
      </section>

      <section>
        <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-red-600">
          Reason code (required)
        </p>
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-2 text-sm"
        >
          <option value="">Select a reason</option>
          {REASON_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </section>

      <section className="grid grid-cols-3 gap-2">
        <div>
          <label className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
            New EMI (₹)
          </label>
          <input
            type="number"
            min={0}
            value={newEmi}
            onChange={(e) => setNewEmi(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
            Tenure (months)
          </label>
          <input
            type="number"
            min={1}
            step={1}
            value={newTenure}
            onChange={(e) => setNewTenure(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
            EMI due (day of month)
          </label>
          <input
            type="number"
            min={1}
            max={28}
            step={1}
            value={newDueDom}
            onChange={(e) => setNewDueDom(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-2 text-sm"
          />
        </div>
      </section>

      <section className="rounded-lg border border-amber-300 bg-amber-50/40 p-4">
        <p className="text-[10px] font-bold uppercase tracking-widest text-amber-800">
          🗎 Borrower notice · exact copy
        </p>
        <div className="mt-2 space-y-2 text-sm text-[color:var(--color-ink)]">
          <p>Dear {borrowerName ?? "Borrower"},</p>
          <p>
            Your loan <code className="rounded bg-amber-100 px-1">{loanApplicationId}</code>{" "}
            with <strong>{lenderLegalName} (NBFC)</strong> is currently overdue.
            Outstanding amount: <strong>{formattedOutstanding}</strong>.
          </p>
          <p>
            As part of our recovery process — delivered through our Loan Service
            Provider <strong>iTarang Battery Solutions (LSP)</strong> — we are
            initiating a <em>loan restructuring review</em> on the battery
            financed under this loan.
          </p>
          <p>
            <strong>Restoration steps:</strong> settle the overdue amount via the
            NBFC app or call our helpline below. Restoration typically completes
            within 2–4 hours after dual-approval verification.
          </p>
          <p className="text-emerald-700">
            <strong>Reversibility:</strong> Restructuring does not take effect
            until the borrower signs the updated schedule
          </p>
          <p className="text-xs italic text-[color:var(--color-ink-muted)]">
            This action is taken in accordance with your loan agreement dated
            at origination and with the RBI Digital Lending Directions 2025. It
            is a non-coercive measure intended only to protect the financed
            asset.
          </p>
          <p className="text-xs">
            🌐 Grievance:{" "}
            <a
              href={grievanceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-700 underline"
            >
              {grievanceUrl}
            </a>{" "}
            · 📞 Helpline: <span className="font-mono">{helpline}</span>
          </p>
        </div>
      </section>

      <AuditTrailPreview
        batteryCode={batteryCode}
        actionLabel="Loan Restructuring Review"
        reason={reason}
        approverChain={["Risk Head", "Ops Lead"]}
        includesBorrowerNotice
      />

      <p className="text-[11px] text-[color:var(--color-ink-muted)]">
        This action complies with RBI Digital Lending Directions 2025 and the
        Fair Practices Code.
      </p>

      {error ? (
        <p className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
          {error}
        </p>
      ) : null}
    </ModalShell>
  );
}

export default RestructuringModal;
