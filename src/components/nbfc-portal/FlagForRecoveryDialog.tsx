"use client";

/**
 * E-035 — FlagForRecoveryDialog
 *
 * Risk Head confirmation dialog for the irreversible "Flag for Recovery"
 * action. Posts to POST /api/nbfc/actions/flag-for-recovery with a reason
 * (>= 20 chars) and surfaces the result.
 */
import { useState } from "react";

interface Props {
  loanSanctionId: string;
  open: boolean;
  onClose: () => void;
  onFlagged?: (result: {
    action_id: string;
    loan_sanction_id: string;
    status: string;
    flagged_at: string;
  }) => void;
  batterySerial?: string | null;
}

export function FlagForRecoveryDialog({
  loanSanctionId,
  open,
  onClose,
  onFlagged,
  batterySerial,
}: Props) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const reasonTooShort = reason.trim().length < 20;

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/nbfc/actions/flag-for-recovery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          loan_sanction_id: loanSanctionId,
          reason: reason.trim(),
          battery_serial: batterySerial ?? undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
        return;
      }
      onFlagged?.(body);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="flag-recovery-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(17,24,39,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 8,
          padding: "1.5rem",
          maxWidth: 480,
          width: "92%",
          boxShadow: "0 20px 25px -5px rgb(0 0 0 / 0.1)",
        }}
      >
        <h2 id="flag-recovery-title" style={{ marginTop: 0, marginBottom: "0.5rem" }}>
          Flag for Recovery
        </h2>
        <p style={{ color: "#374151", marginBottom: "1rem" }}>
          This will permanently flag loan <code>{loanSanctionId}</code> for
          recovery. <strong>This action is irreversible.</strong>
        </p>
        <label style={{ display: "block", fontWeight: 600, marginBottom: 6 }}>
          Reason (min 20 characters)
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          style={{
            width: "100%",
            padding: 8,
            borderRadius: 6,
            border: "1px solid #d1d5db",
            fontFamily: "inherit",
          }}
          placeholder="Document why this loan is being flagged for recovery"
        />
        {reasonTooShort && (
          <p style={{ color: "#b91c1c", fontSize: 12, margin: "4px 0 0" }}>
            {reason.length}/20 characters
          </p>
        )}
        {error && (
          <p style={{ color: "#b91c1c", marginTop: 8 }}>Error: {error}</p>
        )}
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: "1rem",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            style={{ padding: "0.5rem 1rem", borderRadius: 6 }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || reasonTooShort}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: 6,
              background: "#b91c1c",
              color: "#fff",
              border: "none",
              fontWeight: 600,
              opacity: reasonTooShort || submitting ? 0.6 : 1,
            }}
          >
            {submitting ? "Flagging…" : "Flag for Recovery"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default FlagForRecoveryDialog;
