"use client";

/**
 * E-086 — Bulk Immobilisation Initiate Form (Risk Head only)
 *
 * BRD §6.4.3 row "Bulk Immobilisation (>5 batteries)". Risk Head supplies the
 * loan_application_ids list (≥6) and reason_code, ticks the "I have reviewed
 * all evidence" checkbox, and submits to /api/nbfc/actions/bulk-immobilisation/initiate.
 * Server creates a dual_approval_requests row pending iTarang Admin approval.
 */
import { useState } from "react";

const REASON_CODES = [
  { value: "portfolio_dpd_sweep", label: "Portfolio DPD sweep" },
  { value: "fraud_cluster", label: "Fraud cluster" },
  { value: "manual", label: "Manual / ad-hoc" },
] as const;

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | {
      kind: "ok";
      approval_request_id: string;
      batch_size: number;
      status: string;
    }
  | { kind: "error"; message: string };

export function BulkImmobiliseInitiateForm() {
  const [idsText, setIdsText] = useState("");
  const [reasonCode, setReasonCode] =
    useState<(typeof REASON_CODES)[number]["value"]>("portfolio_dpd_sweep");
  const [reviewed, setReviewed] = useState(false);
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  const ids = idsText
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const batchSize = ids.length;
  const tooSmall = batchSize <= 5;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (tooSmall) {
      setState({
        kind: "error",
        message: "Bulk immobilisation requires more than 5 loan IDs.",
      });
      return;
    }
    if (!reviewed) {
      setState({
        kind: "error",
        message: "Confirm the evidence review checkbox before submitting.",
      });
      return;
    }
    setState({ kind: "submitting" });
    try {
      const res = await fetch(
        "/api/nbfc/actions/bulk-immobilisation/initiate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            loan_application_ids: ids,
            reason_code: reasonCode,
            reviewed_evidence_ack: true,
          }),
        },
      );
      const json = await res.json();
      if (!res.ok) {
        setState({
          kind: "error",
          message: json?.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      setState({
        kind: "ok",
        approval_request_id: json.approval_request_id,
        batch_size: json.batch_size,
        status: json.status,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ kind: "error", message: msg });
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 max-w-xl">
      <div>
        <label className="block text-sm font-medium mb-1">
          Loan application IDs (comma or whitespace separated, &gt; 5)
        </label>
        <textarea
          value={idsText}
          onChange={(e) => setIdsText(e.target.value)}
          rows={6}
          className="w-full border rounded p-2 font-mono text-xs"
          placeholder="LN-0001, LN-0002, LN-0003, LN-0004, LN-0005, LN-0006"
        />
        <p className="text-xs text-gray-600 mt-1">
          Batch size: <span className={tooSmall ? "text-red-600" : "text-green-700"}>{batchSize}</span>
          {tooSmall && " — must exceed 5 for bulk gating to apply"}
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Reason code</label>
        <select
          value={reasonCode}
          onChange={(e) =>
            setReasonCode(
              e.target.value as (typeof REASON_CODES)[number]["value"],
            )
          }
          className="w-full border rounded p-2"
        >
          {REASON_CODES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={reviewed}
          onChange={(e) => setReviewed(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          I have reviewed all evidence (DPD, outstanding, last EMI status) for
          every loan in this batch and confirm the bulk immobilisation request
          is justified per RBI Digital Lending Directions 2025.
        </span>
      </label>

      <button
        type="submit"
        disabled={state.kind === "submitting" || tooSmall || !reviewed}
        className="px-4 py-2 rounded bg-red-600 text-white disabled:bg-gray-400"
      >
        {state.kind === "submitting"
          ? "Submitting…"
          : "Initiate bulk immobilisation"}
      </button>

      {state.kind === "ok" && (
        <div className="text-sm rounded border border-green-300 bg-green-50 p-3">
          Approval request created (id <code>{state.approval_request_id}</code>),
          batch size {state.batch_size}, status <strong>{state.status}</strong>.
          iTarang Admin must approve before any battery is immobilised.
        </div>
      )}
      {state.kind === "error" && (
        <div className="text-sm rounded border border-red-300 bg-red-50 p-3">
          {state.message}
        </div>
      )}
    </form>
  );
}

export default BulkImmobiliseInitiateForm;
