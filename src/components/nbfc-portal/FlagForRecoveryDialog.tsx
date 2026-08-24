"use client";

/**
 * E-035 — FlagForRecoveryDialog
 *
 * Risk Head confirmation dialog for the "Flag for Recovery" action. Posts to
 * POST /api/nbfc/actions/flag-for-recovery with a reason (>= 20 chars) and
 * surfaces the result.
 *
 * The flag is no longer described as irreversible: it can be withdrawn via
 * UnflagRecoveryDialog while recovery has not physically started. The copy here
 * says exactly that, because a confirmation that overstates the stakes is the
 * reason operators leave wrong flags standing.
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
  /** Optional entity context, threaded into the audit-log payload. */
  context?: { entity_type: "lead" | "loan"; lead_id?: string };
}

export function FlagForRecoveryDialog({
  loanSanctionId,
  open,
  onClose,
  onFlagged,
  batterySerial,
  context,
}: Props) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When the loan is already flagged (409 CONFLICT), we switch the dialog into a
  // calm, informational state instead of showing a red error string.
  const [alreadyFlagged, setAlreadyFlagged] = useState(false);

  if (!open) return null;

  const reasonTooShort = reason.trim().length < 20;

  function handleClose() {
    // Reset the transient states so re-opening the dialog starts clean.
    setError(null);
    setAlreadyFlagged(false);
    onClose();
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    setAlreadyFlagged(false);
    try {
      const res = await fetch("/api/nbfc/actions/flag-for-recovery", {
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
        // A 409 (or an "already flagged" message) is an expected, benign outcome —
        // surface it as information, not as a failure.
        if (res.status === 409 || /already\s+flagged/i.test(rawMsg)) {
          setAlreadyFlagged(true);
          return;
        }
        // Strip the internal "CODE: " prefix from any other server error.
        setError(rawMsg.replace(/^[A-Z_]+:\s*/, ""));
        return;
      }
      onFlagged?.(body);
      handleClose();
    } catch {
      setError(
        "Something went wrong while flagging this loan. Please check your connection and try again.",
      );
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
        {alreadyFlagged ? (
          <>
            <h2
              id="flag-recovery-title"
              style={{ margin: 0, marginBottom: "0.75rem", fontSize: 18 }}
            >
              Already flagged for recovery
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
              Loan <code>{loanSanctionId}</code> is already flagged for recovery,
              so no further action is needed. You can track its progress in the{" "}
              <strong>Recovery &amp; Auction</strong> queue and the audit log.
            </div>
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
              id="flag-recovery-title"
              style={{ marginTop: 0, marginBottom: "0.5rem" }}
            >
              Flag for Recovery
            </h2>
            <p style={{ color: "#374151", marginBottom: "1rem" }}>
              This flags loan <code>{loanSanctionId}</code> for recovery and
              opens it in the recovery queue.{" "}
              <strong>
                It can be withdrawn until recovery physically starts
              </strong>{" "}
              — once the battery is inspected, sent for refurbishment or lotted
              for auction, the flag is locked in. Both the flag and any
              withdrawal are written to the audit log.
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
              placeholder="Document why this loan is being flagged for recovery"
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
          </>
        )}
      </div>
    </div>
  );
}

export default FlagForRecoveryDialog;
