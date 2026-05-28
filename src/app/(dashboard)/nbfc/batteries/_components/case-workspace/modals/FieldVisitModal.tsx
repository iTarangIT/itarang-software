"use client";

import { useState } from "react";
import { ModalShell } from "./ModalShell";
import AuditTrailPreview from "../AuditTrailPreview";

interface Props {
  open: boolean;
  onClose: () => void;
  loanSanctionId: string;
  batteryCode: string;
  borrowerName: string | null;
  onSubmitted: () => void;
}

// Each label expands to a canned reason string >= 10 chars to satisfy the API
// (POST /api/nbfc/actions/field-visit takes free-text `reason`, min 10 chars).
const REASON_OPTIONS = [
  { label: "Usage drop + idle days", reason: "Usage drop + idle days observed in telemetry; verify borrower in person." },
  { label: "Repeated missed reminders", reason: "Borrower unresponsive to repeated payment reminders." },
  { label: "Location mismatch / geofence breach", reason: "GPS location anomaly relative to declared address." },
  { label: "Pre-recovery soft visit", reason: "Soft visit ahead of recovery escalation per SOP." },
];

export function FieldVisitModal({
  open,
  onClose,
  loanSanctionId,
  batteryCode,
  borrowerName,
  onSubmitted,
}: Props) {
  const [reasonIdx, setReasonIdx] = useState<number | "">("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choice =
    typeof reasonIdx === "number" ? REASON_OPTIONS[reasonIdx] : null;

  async function submit() {
    if (!choice) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/nbfc/actions/field-visit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          loan_sanction_id: loanSanctionId,
          reason: choice.reason,
        }),
      });
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

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="You are about to request a field visit"
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
            disabled={!choice || submitting}
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
          <li>Recovery agent assigned based on proximity and workload</li>
          <li>Agent receives pre-call briefing (telemetry + EMI history, no PII beyond contact)</li>
          <li>Outcome recorded in case file; updates borrower-visible timeline</li>
        </ol>
      </section>

      <section className="rounded-lg border border-sky-200 bg-sky-50/60 p-3">
        <p className="text-[10px] font-bold uppercase tracking-widest text-sky-700">
          🛡 Approvals required
        </p>
        <p className="mt-1 text-sm">
          <span className="font-semibold">Risk Head</span> · ~1 hr
        </p>
      </section>

      <section>
        <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-red-600">
          Reason code (required)
        </p>
        <select
          value={reasonIdx}
          onChange={(e) =>
            setReasonIdx(e.target.value === "" ? "" : Number(e.target.value))
          }
          className="w-full rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-2 text-sm"
        >
          <option value="">Select a reason</option>
          {REASON_OPTIONS.map((r, idx) => (
            <option key={r.label} value={idx}>
              {r.label}
            </option>
          ))}
        </select>
      </section>

      <AuditTrailPreview
        batteryCode={batteryCode}
        actionLabel="Request Field Visit"
        reason={choice?.label ?? ""}
        approverChain={["Risk Head"]}
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

export default FieldVisitModal;
