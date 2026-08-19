"use client";

/**
 * E-238 / E-245 — the dealer's message box against a financing offer.
 *
 * E-238 shipped this as six editable term fields (`current → your ask`). E-245
 * removed them: the dealer is not the party that prices a loan, so inviting them
 * to type an ROI produced asks the lender could not act on and rounds whose
 * "diff" was noise. The dealer now says what the customer needs in words, and
 * the NBFC revises the numbers on its own side.
 *
 * Both dealer-side actions are the same shape — write something, send it — so
 * one component serves both via `mode`:
 *   negotiate → POST /api/lead/[id]/negotiate-offer (asks for revised terms)
 *   close     → POST /api/lead/[id]/close-offer     (walks away from this lender)
 * The message is REQUIRED in both. Closing especially: the NBFC's only record of
 * why it lost the deal is what the dealer typed here.
 */
import { useState } from "react";

import { confirmDialog } from "@/components/ui/confirm-dialog";
import { MAX_MESSAGE_LENGTH } from "@/lib/nbfc/offer-negotiation";

export type NegotiationPanelMode = "negotiate" | "close";

const COPY: Record<
  NegotiationPanelMode,
  {
    heading: string;
    hint: string;
    label: string;
    placeholder: string;
    submit: string;
    busy: string;
    endpoint: (leadId: string) => string;
    confirmTitle: string;
    confirmMessage: string;
    confirmText: string;
    danger?: boolean;
  }
> = {
  negotiate: {
    heading: "Negotiate",
    hint: "Tell the NBFC what the customer needs. They will review it and revise the offer.",
    label: "Message to the NBFC",
    placeholder:
      "e.g. Customer can manage a higher down payment if the ROI comes down…",
    submit: "Send message",
    busy: "Sending…",
    endpoint: (leadId) => `/api/lead/${leadId}/negotiate-offer`,
    confirmTitle: "Send this to the NBFC?",
    confirmMessage:
      "The NBFC will see your message against this offer and can revise its terms in response.",
    confirmText: "Send message",
  },
  close: {
    heading: "Delete loan product",
    hint: "Tell the NBFC why the customer is dropping this loan product. This cannot be undone.",
    label: "Message to the NBFC",
    placeholder:
      "e.g. Customer is going ahead with another lender — the EMI here is above budget.",
    submit: "Delete loan product",
    busy: "Deleting…",
    endpoint: (leadId) => `/api/lead/${leadId}/close-offer`,
    confirmTitle: "Delete this loan product?",
    confirmMessage:
      "This ends the conversation with this lender for good — you will not be able to select them or negotiate again. You can then pick a different lender for this lead.",
    confirmText: "Delete loan product",
    danger: true,
  },
};

export default function OfferNegotiationPanel({
  leadId,
  nbfcId,
  mode = "negotiate",
  onSent,
  onDirtyChange,
  onCancel,
}: {
  leadId: string;
  nbfcId: number;
  mode?: NegotiationPanelMode;
  onSent: () => void | Promise<void>;
  /** Lets the parent pause polling so a refetch cannot clobber typed input. */
  onDirtyChange?: (dirty: boolean) => void;
  onCancel: () => void;
}) {
  const copy = COPY[mode];
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSend = message.trim() !== "" && !busy;

  async function send() {
    const ok = await confirmDialog({
      title: copy.confirmTitle,
      message: `${copy.confirmMessage}\n\n"${message.trim()}"`,
      confirmText: copy.confirmText,
      ...(copy.danger ? { variant: "danger" as const } : {}),
    });
    if (!ok) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(copy.endpoint(leadId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nbfcId, message: message.trim() }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: { message?: string };
      };
      if (!res.ok || j.success === false) throw new Error(j.error?.message ?? `HTTP ${res.status}`);
      onDirtyChange?.(false);
      await onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const accent =
    mode === "close"
      ? { box: "border-red-200 bg-red-50/40", heading: "text-red-800" }
      : { box: "border-violet-200 bg-violet-50/40", heading: "text-violet-800" };

  return (
    <div className={`mt-3 rounded-lg border p-3 ${accent.box}`}>
      <p className={`text-[10px] font-bold uppercase tracking-wider ${accent.heading}`}>
        {copy.heading}
      </p>
      <p className="mt-0.5 text-[11px] text-slate-600">{copy.hint}</p>

      <label className="mt-2.5 block text-[11px] font-semibold text-slate-500">
        {copy.label} <span className="text-red-500">*</span>
        <textarea
          value={message}
          rows={3}
          maxLength={MAX_MESSAGE_LENGTH}
          onChange={(e) => {
            setMessage(e.target.value);
            onDirtyChange?.(e.target.value.trim() !== "");
          }}
          placeholder={copy.placeholder}
          className="mt-1 w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs font-normal"
        />
      </label>

      {error && <p className="mt-1.5 text-[11px] text-red-600">{error}</p>}

      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          title={!canSend && !busy ? "Write a message first" : undefined}
          className={`rounded-md px-3 py-1.5 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-50 ${
            mode === "close" ? "bg-red-600" : "bg-[color:var(--color-brand-navy)]"
          }`}
        >
          {busy ? copy.busy : copy.submit}
        </button>
        <button
          type="button"
          onClick={() => {
            onDirtyChange?.(false);
            onCancel();
          }}
          disabled={busy}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700"
        >
          Cancel
        </button>
        <span className="ml-auto text-[10px] text-slate-400">
          {message.trim().length}/{MAX_MESSAGE_LENGTH}
        </span>
      </div>
    </div>
  );
}
