"use client";

/**
 * E-090 — DPDPA Consent Withdrawal form.
 *
 * Submitted by an NBFC operator after the borrower contacts the grievance
 * channel. POSTs to /api/nbfc/dpdpa/consent/withdraw and surfaces the
 * resulting status badge so the operator can confirm the change took effect.
 *
 * NOTE: this is a server-side recording form, not a borrower-facing UI; the
 * borrower-facing path is the published grievance / helpline / email channel
 * referenced in BRD §6.4.4.
 */
import { useState } from "react";

const CHANNELS = [
  { value: "grievance_portal", label: "Grievance portal" },
  { value: "helpline", label: "Helpline" },
  { value: "email", label: "Email" },
] as const;

type Channel = (typeof CHANNELS)[number]["value"];

interface WithdrawResult {
  lead_id: string;
  consent_id: string;
  status: "withdrawn";
  withdrawn_at: string;
  withdrawal_channel: Channel;
}

export function ConsentWithdrawForm({
  initialLeadId = "",
}: {
  initialLeadId?: string;
}) {
  const [leadId, setLeadId] = useState(initialLeadId);
  const [channel, setChannel] = useState<Channel>("grievance_portal");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<WithdrawResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/nbfc/dpdpa/consent/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_id: leadId,
          withdrawal_channel: channel,
          reason: reason.trim() ? reason.trim() : undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j?.error ?? `Request failed (${res.status})`);
      } else {
        setResult(j as WithdrawResult);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div>
        <h3 className="text-sm font-semibold text-slate-900">
          Record DPDPA consent withdrawal
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          Telemetry-derived scopes (risk assessment, warranty management) will
          be deactivated. Existing loan obligations remain in force.
        </p>
      </div>

      <label className="block text-xs font-medium text-slate-700">
        Lead ID
        <input
          type="text"
          required
          value={leadId}
          onChange={(e) => setLeadId(e.target.value)}
          className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-sm"
        />
      </label>

      <label className="block text-xs font-medium text-slate-700">
        Withdrawal channel
        <select
          required
          value={channel}
          onChange={(e) => setChannel(e.target.value as Channel)}
          className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-sm"
        >
          {CHANNELS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <label className="block text-xs font-medium text-slate-700">
        Reason (optional)
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={3}
          className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-sm"
        />
      </label>

      <button
        type="submit"
        disabled={submitting || !leadId.trim()}
        className="rounded bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:bg-slate-300"
      >
        {submitting ? "Recording…" : "Record withdrawal"}
      </button>

      {error && (
        <div className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">
          {error}
        </div>
      )}

      {result && (
        <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800">
          Recorded: status={result.status}, withdrawn_at={result.withdrawn_at}.
        </div>
      )}
    </form>
  );
}

export default ConsentWithdrawForm;
