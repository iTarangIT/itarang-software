"use client";

/**
 * E-031 — SendPaymentReminderButton
 *
 * One-click NBFC-user action to send a payment reminder for a given
 * loan_sanction_id. Posts to POST /api/nbfc/actions/payment-reminder. The
 * action is auto-approved (BRD §6.1.6) and the audit-log row is written
 * server-side; the button surfaces only success/error feedback.
 */
import { useState } from "react";

type Channel = "sms" | "whatsapp" | "email";

interface Props {
  loanSanctionId: string;
  defaultChannel?: Channel;
  onSent?: (result: {
    action_id: string;
    loan_sanction_id: string;
    channel: string;
    status: string;
    created_at: string;
  }) => void;
}

export function SendPaymentReminderButton({
  loanSanctionId,
  defaultChannel = "sms",
  onSent,
}: Props) {
  const [channel, setChannel] = useState<Channel>(defaultChannel);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/nbfc/actions/payment-reminder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          loan_sanction_id: loanSanctionId,
          channel,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(String(body?.error ?? `HTTP ${res.status}`));
        return;
      }
      setSentAt(body.created_at ?? new Date().toISOString());
      onSent?.(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <select
        aria-label="Reminder channel"
        className="rounded border border-gray-300 bg-white px-2 py-1 text-sm"
        value={channel}
        onChange={(e) => setChannel(e.target.value as Channel)}
        disabled={submitting}
      >
        <option value="sms">SMS</option>
        <option value="whatsapp">WhatsApp</option>
        <option value="email">Email</option>
      </select>
      <button
        type="button"
        onClick={submit}
        disabled={submitting}
        className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
      >
        {submitting ? "Sending…" : "Send Payment Reminder"}
      </button>
      {sentAt && (
        <span className="text-xs text-green-700">
          Reminder queued at {new Date(sentAt).toLocaleTimeString()}
        </span>
      )}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}
