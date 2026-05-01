"use client";

/**
 * E-088 — Audit log data export initiation form.
 *
 * Renders a form for the requestor to:
 *   - pick a from/to date-time range,
 *   - optionally narrow by entity_type,
 *   - enter their MFA token (must come from the in-session MFA challenge),
 *   - tick the "I have reviewed the requested evidence" acknowledgement,
 *   - supply a reason_code.
 *
 * On submit POSTs to /api/nbfc/actions/audit-log-export/initiate. The form
 * does *not* show a download URL on success — the export only produces an
 * artefact after an iTarang Compliance Officer approves the request via the
 * E-082 dual-approval gate. We only confirm "pending approval" + show the
 * approval_request_id so the user can track it.
 */
import { useState, type FormEvent } from "react";

type Props = {
  fetcher?: typeof fetch;
};

type InitiateResponse = {
  approval_request_id?: string;
  status?: string;
  action_type?: string;
  export_request_id?: string;
  ok?: false;
  error?: string;
};

export default function AuditExportInitiateForm({ fetcher }: Props) {
  const fx = fetcher ?? fetch;
  const [fromTs, setFromTs] = useState("");
  const [toTs, setToTs] = useState("");
  const [entityType, setEntityType] = useState("");
  const [mfaToken, setMfaToken] = useState("");
  const [reasonCode, setReasonCode] = useState("");
  const [reviewedAck, setReviewedAck] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{
    approval_request_id: string;
    status: string;
  } | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!reviewedAck) {
      setError("You must acknowledge that you have reviewed the request scope.");
      return;
    }
    if (!fromTs || !toTs || !mfaToken || !reasonCode) {
      setError("All required fields must be filled.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fx("/api/nbfc/actions/audit-log-export/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_ts: new Date(fromTs).toISOString(),
          to_ts: new Date(toTs).toISOString(),
          entity_type: entityType || undefined,
          mfa_token: mfaToken,
          reason_code: reasonCode,
          reviewed_evidence_ack: true,
        }),
      });
      const body = (await res.json()) as InitiateResponse;
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      if (!body.approval_request_id) {
        setError("Server did not return an approval_request_id.");
        return;
      }
      setSuccess({
        approval_request_id: body.approval_request_id,
        status: body.status ?? "pending_approval",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-md border p-4"
      aria-label="Audit log export initiation form"
    >
      <h2 className="text-lg font-semibold">Initiate audit log export</h2>
      <p className="text-sm text-gray-600">
        Bulk audit-log exports require MFA on initiation and approval by an
        iTarang Compliance Officer before a download URL is produced.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col text-sm">
          From
          <input
            type="datetime-local"
            required
            value={fromTs}
            onChange={(e) => setFromTs(e.target.value)}
            className="rounded border p-1"
          />
        </label>
        <label className="flex flex-col text-sm">
          To
          <input
            type="datetime-local"
            required
            value={toTs}
            onChange={(e) => setToTs(e.target.value)}
            className="rounded border p-1"
          />
        </label>
      </div>

      <label className="flex flex-col text-sm">
        Entity type (optional)
        <input
          type="text"
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
          placeholder="e.g. dual_approval_request"
          className="rounded border p-1"
        />
      </label>

      <label className="flex flex-col text-sm">
        MFA token
        <input
          type="text"
          required
          value={mfaToken}
          onChange={(e) => setMfaToken(e.target.value)}
          autoComplete="one-time-code"
          className="rounded border p-1"
        />
      </label>

      <label className="flex flex-col text-sm">
        Reason code
        <input
          type="text"
          required
          value={reasonCode}
          onChange={(e) => setReasonCode(e.target.value)}
          placeholder="e.g. rbi_audit_request"
          className="rounded border p-1"
        />
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={reviewedAck}
          onChange={(e) => setReviewedAck(e.target.checked)}
        />
        I have reviewed the request scope and confirm it is justified.
      </label>

      <button
        type="submit"
        disabled={submitting || !reviewedAck}
        className="rounded bg-blue-600 px-4 py-2 text-white disabled:bg-gray-400"
      >
        {submitting ? "Submitting…" : "Submit for approval"}
      </button>

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="text-sm text-green-700">
          Pending approval. Request ID: {success.approval_request_id} (status:{" "}
          {success.status})
        </p>
      )}
    </form>
  );
}
