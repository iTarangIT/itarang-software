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

// Friendly labels surface in the dropdown; map to the API's `channel` enum.
const REASON_OPTIONS: Array<{ label: string; channel: "sms" | "whatsapp" | "email" }> = [
  { label: "EMI due today", channel: "sms" },
  { label: "EMI overdue 1–7 days", channel: "sms" },
  { label: "EMI overdue 8–30 days", channel: "whatsapp" },
  { label: "Final warning before recovery action", channel: "email" },
];

export function PaymentReminderModal({
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

  const reason =
    typeof reasonIdx === "number" ? REASON_OPTIONS[reasonIdx] : null;

  async function submit() {
    if (!reason) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/nbfc/actions/payment-reminder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          loan_sanction_id: loanSanctionId,
          channel: reason.channel,
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
      title="You are about to send a payment reminder"
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
            disabled={!reason || submitting}
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
          <li>SMS + app notification dispatched to borrower using the preview below</li>
          <li>Audit entry logged with timestamp, requester, reason</li>
          <li>Follow-up cadence scheduled: +3d if unpaid, +7d final warning</li>
        </ol>
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
        actionLabel="Send Payment Reminder"
        reason={reason?.label ?? ""}
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

export default PaymentReminderModal;
