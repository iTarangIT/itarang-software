"use client";

/**
 * E-238 — the dealer's counter-offer form, opened from a financing offer card.
 *
 * Each of the six terms is shown as `current → [your ask]`, prefilled with the
 * NBFC's standing value, so the dealer edits a number in place rather than
 * restating the whole offer. Only the fields that actually MOVED are sent as
 * asks; the rest carry through unchanged on the server side, which is what
 * keeps every round a complete snapshot without making the dealer retype it.
 *
 * Submit is blocked until something has changed or a message has been written —
 * an empty counter would burn a round and notify the NBFC about nothing.
 */
import { useMemo, useState } from "react";

import { confirmDialog } from "@/components/ui/confirm-dialog";
import { MAX_MESSAGE_LENGTH, NEGOTIABLE_FIELDS, FIELD_LABEL, sameTerm } from "@/lib/nbfc/offer-negotiation";
import type { NegotiableField } from "@/lib/nbfc/offer-negotiation";

export interface NegotiableOffer {
  loan_amount: string | null;
  roi_pct: string | null;
  emi_amount: string | null;
  tenure_months: number | null;
  down_payment: string | null;
  processing_fee: string | null;
}

const SUFFIX: Partial<Record<NegotiableField, string>> = { roi_pct: "%", tenure_months: "mo" };
const PREFIX: Partial<Record<NegotiableField, string>> = {
  loan_amount: "₹",
  emi_amount: "₹",
  down_payment: "₹",
  processing_fee: "₹",
};

const shown = (v: string | number | null): string =>
  v == null || v === "" ? "—" : `${v}`;

export default function OfferNegotiationPanel({
  leadId,
  nbfcId,
  offer,
  onSent,
  onDirtyChange,
  onCancel,
}: {
  leadId: string;
  nbfcId: number;
  offer: NegotiableOffer;
  onSent: () => void | Promise<void>;
  /** Lets the parent pause polling so a refetch cannot clobber typed input. */
  onDirtyChange?: (dirty: boolean) => void;
  onCancel: () => void;
}) {
  const initial = useMemo(
    () =>
      Object.fromEntries(
        NEGOTIABLE_FIELDS.map((f) => [f, offer[f] == null ? "" : String(offer[f])]),
      ) as Record<NegotiableField, string>,
    [offer],
  );

  const [form, setForm] = useState<Record<NegotiableField, string>>(initial);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const moved = NEGOTIABLE_FIELDS.filter(
    (f) => form[f].trim() !== "" && !sameTerm(offer[f], form[f].trim()),
  );
  const invalid = NEGOTIABLE_FIELDS.filter(
    (f) => form[f].trim() !== "" && Number.isNaN(Number(form[f].trim())),
  );
  const canSend = (moved.length > 0 || message.trim() !== "") && invalid.length === 0 && !busy;

  function setField(f: NegotiableField, v: string) {
    setForm((s) => {
      const next = { ...s, [f]: v };
      onDirtyChange?.(
        NEGOTIABLE_FIELDS.some((k) => next[k].trim() !== (initial[k] ?? "")) || message.trim() !== "",
      );
      return next;
    });
  }

  async function send() {
    const summary = moved
      .map((f) => `${FIELD_LABEL[f]}: ${shown(offer[f])} → ${form[f].trim()}`)
      .join("\n");
    const ok = await confirmDialog({
      title: "Send counter-offer?",
      message: summary
        ? `The NBFC will be asked to revise its terms:\n\n${summary}`
        : "The NBFC will receive your message against this offer.",
      confirmText: "Send counter-offer",
    });
    if (!ok) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/lead/${leadId}/negotiate-offer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nbfcId,
          // Send only what moved. Unchanged terms are carried through server-side.
          ...Object.fromEntries(moved.map((f) => [f, form[f].trim()])),
          message: message.trim() || null,
        }),
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

  return (
    <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50/40 p-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-violet-800">Negotiate</p>
      <p className="mt-0.5 text-[11px] text-slate-600">
        Change what the customer is asking for. Leave a field as-is to accept it.
      </p>

      <div className="mt-2.5 space-y-1.5">
        {NEGOTIABLE_FIELDS.map((f) => {
          const changed = moved.includes(f);
          const isBad = invalid.includes(f);
          return (
            <label key={f} className="flex items-center gap-2 text-[11px]">
              <span className="w-24 shrink-0 font-semibold text-slate-500">{FIELD_LABEL[f]}</span>
              <span className="w-20 shrink-0 text-right text-slate-400">
                {PREFIX[f] ?? ""}
                {shown(offer[f])}
                {SUFFIX[f] ? ` ${SUFFIX[f]}` : ""}
              </span>
              <span className="shrink-0 text-slate-300">→</span>
              <input
                type="number"
                inputMode="decimal"
                value={form[f]}
                onChange={(e) => setField(f, e.target.value)}
                className={`w-full rounded-md border px-2 py-1 text-xs ${
                  isBad
                    ? "border-red-300 bg-red-50"
                    : changed
                      ? "border-violet-300 bg-white font-semibold text-slate-900"
                      : "border-slate-200 bg-white text-slate-600"
                }`}
              />
            </label>
          );
        })}
      </div>

      <label className="mt-2.5 block text-[11px] font-semibold text-slate-500">
        Message to the NBFC <span className="font-normal text-slate-400">(optional)</span>
        <textarea
          value={message}
          rows={2}
          maxLength={MAX_MESSAGE_LENGTH}
          onChange={(e) => {
            setMessage(e.target.value);
            onDirtyChange?.(
              e.target.value.trim() !== "" ||
                NEGOTIABLE_FIELDS.some((k) => form[k].trim() !== (initial[k] ?? "")),
            );
          }}
          placeholder="e.g. Customer can manage a higher down payment if the ROI comes down…"
          className="mt-1 w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs font-normal"
        />
      </label>

      {error && <p className="mt-1.5 text-[11px] text-red-600">{error}</p>}

      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          title={
            !canSend && !busy
              ? invalid.length > 0
                ? "Some values are not numbers"
                : "Change a term or write a message first"
              : undefined
          }
          className="rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send counter-offer"}
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
        {moved.length > 0 && (
          <span className="text-[11px] text-slate-500">
            {moved.length} term{moved.length === 1 ? "" : "s"} changed
          </span>
        )}
      </div>
    </div>
  );
}
