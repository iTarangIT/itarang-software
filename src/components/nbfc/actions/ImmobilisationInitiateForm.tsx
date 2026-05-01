/**
 * E-083 — Battery immobilisation initiate form (Risk Manager).
 *
 * Posts to /api/nbfc/actions/battery-immobilisation/initiate. The form
 * surfaces the four reason codes accepted by the API and forces an explicit
 * "I have reviewed the evidence" acknowledgement before the action is sent —
 * mirroring the BRD's two-person-rule requirement that the initiator
 * inspects the evidence snapshot before requesting approval.
 *
 * The route returns approval_request_id + status='pending_approval'; this
 * component renders the resulting approval id so the Risk Head can pick it
 * up from the dual-approval queue.
 */
"use client";
import { useState } from "react";

interface InitiateResponse {
  approval_request_id?: string;
  status?: string;
  action_type?: string;
  ok?: false;
  error?: string;
}

const REASON_CODES: Array<{ value: string; label: string }> = [
  { value: "dpd_60", label: "DPD 60+ days" },
  { value: "dpd_90", label: "DPD 90+ days" },
  { value: "fraud_flag", label: "Fraud flag raised" },
  { value: "manual", label: "Manual escalation" },
];

export function ImmobilisationInitiateForm() {
  const [loanApplicationId, setLoanApplicationId] = useState("");
  const [imei, setImei] = useState("");
  const [reasonCode, setReasonCode] = useState("dpd_60");
  const [reviewed, setReviewed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<InitiateResponse | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch(
        "/api/nbfc/actions/battery-immobilisation/initiate",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            loan_application_id: loanApplicationId,
            imei,
            reason_code: reasonCode,
            reviewed_evidence_ack: reviewed,
          }),
        },
      );
      const body = (await res.json()) as InitiateResponse;
      setResult(body);
    } catch (err) {
      setResult({ ok: false, error: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 max-w-md">
      <div>
        <label className="block text-sm font-medium">Loan application id</label>
        <input
          type="text"
          required
          value={loanApplicationId}
          onChange={(e) => setLoanApplicationId(e.target.value)}
          className="mt-1 w-full rounded border px-3 py-2"
        />
      </div>
      <div>
        <label className="block text-sm font-medium">IMEI</label>
        <input
          type="text"
          required
          value={imei}
          onChange={(e) => setImei(e.target.value)}
          className="mt-1 w-full rounded border px-3 py-2"
        />
      </div>
      <div>
        <label className="block text-sm font-medium">Reason code</label>
        <select
          value={reasonCode}
          onChange={(e) => setReasonCode(e.target.value)}
          className="mt-1 w-full rounded border px-3 py-2"
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
        />
        <span>
          I have reviewed the evidence snapshot (DPD, EMIs, telemetry) and
          attest that immobilisation is warranted.
        </span>
      </label>
      <button
        type="submit"
        disabled={submitting || !reviewed}
        className="rounded bg-red-600 px-4 py-2 text-white disabled:opacity-50"
      >
        {submitting ? "Sending…" : "Request immobilisation approval"}
      </button>
      {result?.approval_request_id && (
        <p className="text-sm text-green-700">
          Approval request created: <code>{result.approval_request_id}</code>{" "}
          (status: {result.status})
        </p>
      )}
      {result?.ok === false && (
        <p className="text-sm text-red-700">Error: {result.error}</p>
      )}
    </form>
  );
}

export default ImmobilisationInitiateForm;
