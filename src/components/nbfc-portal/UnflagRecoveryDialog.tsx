"use client";

/**
 * UnflagRecoveryDialog — withdraw a recovery flag raised in error.
 *
 * The counterpart to FlagForRecoveryDialog. Posts to
 * POST /api/nbfc/actions/unflag-recovery with a reason (>= 20 chars), the same
 * bar the flag itself has to clear, because the withdrawal lands in the audit
 * log next to it and "removed by mistake" is not a reason anyone can act on.
 *
 * The server refuses the withdrawal once recovery has physically started
 * (inspection recorded, workshop job raised, battery lotted, pipeline moved on).
 * That comes back as a 409 whose message names the blocker, and this dialog
 * shows it verbatim rather than flattening it to "something went wrong" — the
 * operator needs to know WHICH downstream step now owns this battery.
 */
import { useState } from "react";

interface Props {
  loanSanctionId: string;
  open: boolean;
  onClose: () => void;
  onUnflagged?: (result: {
    action_id: string;
    loan_sanction_id: string;
    status: string;
    unflagged_at: string;
  }) => void;
  batterySerial?: string | null;
  /** Optional entity context, threaded into the audit-log payload. */
  context?: { entity_type: "lead" | "loan"; lead_id?: string };
}

export function UnflagRecoveryDialog({
  loanSanctionId,
  open,
  onClose,
  onUnflagged,
  batterySerial,
  context,
}: Props) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A 409 is not a failure of the app — it is the recovery workflow having
  // moved past the point where a flag is just a flag. Shown as its own state.
  const [blocked, setBlocked] = useState<string | null>(null);

  if (!open) return null;

  const reasonTooShort = reason.trim().length < 20;

  function handleClose() {
    setError(null);
    setBlocked(null);
    onClose();
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    setBlocked(null);
    try {
      const res = await fetch("/api/nbfc/actions/unflag-recovery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          loan_sanction_id: loanSanctionId,
          reason: reason.trim(),
          battery_serial: batterySerial ?? undefined,
          ...(context ? { context } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        const rawMsg =
          typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
        const clean = rawMsg.replace(/^[A-Z_]+:\s*/, "");
        if (res.status === 409) {
          setBlocked(clean);
          return;
        }
        setError(clean);
        return;
      }
      onUnflagged?.(body);
      handleClose();
    } catch {
      setError(
        "Something went wrong while withdrawing this flag. Please check your connection and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="unflag-recovery-title"
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
        {blocked ? (
          <>
            <h2
              id="unflag-recovery-title"
              style={{ margin: 0, marginBottom: "0.75rem", fontSize: 18 }}
            >
              Flag can no longer be withdrawn
            </h2>
            <div
              role="status"
              style={{
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: 8,
                padding: "0.875rem 1rem",
                color: "#92400e",
                lineHeight: 1.5,
              }}
            >
              {blocked}
            </div>
            <p
              style={{
                color: "#6b7280",
                fontSize: 12,
                lineHeight: 1.5,
                marginTop: "0.75rem",
              }}
            >
              Recovery has already progressed for this loan. Continue from the{" "}
              <strong>Recovery &amp; Auction</strong> queue instead.
            </p>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                marginTop: "1.25rem",
              }}
            >
              <button
                type="button"
                onClick={handleClose}
                style={{
                  padding: "0.5rem 1.25rem",
                  borderRadius: 6,
                  background: "#111827",
                  color: "#fff",
                  border: "none",
                  fontWeight: 600,
                }}
              >
                Got it
              </button>
            </div>
          </>
        ) : (
          <>
            <h2
              id="unflag-recovery-title"
              style={{ marginTop: 0, marginBottom: "0.5rem" }}
            >
              Withdraw Recovery Flag
            </h2>
            <p style={{ color: "#374151", marginBottom: "1rem" }}>
              This removes the recovery flag on loan <code>{loanSanctionId}</code>{" "}
              and withdraws it from the recovery queue. The original flag stays
              in the audit log, and this withdrawal is logged alongside it.
            </p>
            <label
              style={{ display: "block", fontWeight: 600, marginBottom: 6 }}
            >
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
              placeholder="Document why this recovery flag is being withdrawn"
            />
            {reasonTooShort && (
              <p style={{ color: "#b91c1c", fontSize: 12, margin: "4px 0 0" }}>
                {reason.length}/20 characters
              </p>
            )}
            {error && (
              <div
                role="alert"
                style={{
                  marginTop: 10,
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  borderRadius: 8,
                  padding: "0.75rem 1rem",
                  color: "#b91c1c",
                  lineHeight: 1.5,
                }}
              >
                {error}
              </div>
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
                onClick={handleClose}
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
                  background: "#4338ca",
                  color: "#fff",
                  border: "none",
                  fontWeight: 600,
                  opacity: reasonTooShort || submitting ? 0.6 : 1,
                }}
              >
                {submitting ? "Withdrawing…" : "Withdraw Flag"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default UnflagRecoveryDialog;
