"use client";

/**
 * E-242 — review an approved quotation draft and send it to the dealer.
 *
 * The last step of the flow the 2026-08-13 call described: approval generates a
 * draft, the sales manager is notified, opens it here, and sends it over
 * WhatsApp and/or email.
 *
 * ## Why the button can be disabled and the dialog still opens
 *
 * The gate lives on the server — the send route refuses anything not approved
 * and anything with no generated document. This dialog mirrors that state so
 * the reason is visible ("awaiting approval", "draft failed") rather than
 * leaving a dead button with no explanation. It never decides; it explains.
 *
 * ## Partial sends are reported as partial
 *
 * Each channel succeeds or fails on its own, so the result panel lists both. A
 * delivered email with a failed WhatsApp must not read as "failed" — there is
 * no un-sending the email, and a blanket failure would invite a second send.
 */

import React from "react";
import {
  X,
  Mail,
  MessageCircle,
  FileText,
  RefreshCw,
  Check,
  AlertTriangle,
  Loader2,
} from "lucide-react";

type Channel = "email" | "whatsapp";

interface DispatchRow {
  dispatch_id: string;
  channel: string;
  recipient: string;
  status: string;
  error: string | null;
  sent_by_name: string | null;
  created_at: string;
}

interface SendState {
  commercial_id: string;
  version_no: number;
  approval_status: string | null;
  quote_number: string | null;
  quote_pdf_url: string | null;
  quote_pdf_error: string | null;
  sendable: boolean;
  dealer_name: string | null;
  email: string | null;
  phone: string | null;
  /** E-243 — the dealer's own answer, once they have given one. */
  dealer_decision: "approved" | "declined" | null;
  dealer_decision_at: string | null;
  dealer_decision_via: string | null;
  dealer_decision_note: string | null;
  dispatches: DispatchRow[];
}

/** The subset of a commercials row that prints on the dealer's document. */
export interface QuotationTerms {
  payment_method: string | null;
  credit_terms: string | null;
  delivery_terms: string | null;
  warranty_terms: string | null;
  deal_notes: string | null;
}

interface Outcome {
  channel: Channel;
  recipient: string;
  status: "sent" | "failed";
  error?: string;
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function QuotationSendDialog({
  leadId,
  commercialId,
  terms,
  onClose,
}: {
  leadId: string;
  commercialId: string;
  /**
   * The commercials row's terms, passed in rather than re-fetched: the pane
   * already holds the version this dialog was opened for.
   */
  terms?: QuotationTerms | null;
  onClose: () => void;
}) {
  const base = `/api/inside-sales/lead/${leadId}/commercials/${commercialId}`;

  const termRows = (
    [
      ["Payment", terms?.payment_method],
      ["Credit", terms?.credit_terms],
      ["Delivery", terms?.delivery_terms],
      ["Warranty", terms?.warranty_terms],
      ["Notes", terms?.deal_notes],
    ] as [string, string | null | undefined][]
  ).filter((r): r is [string, string] => !!r[1]);

  const [state, setState] = React.useState<SendState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [channels, setChannels] = React.useState<Channel[]>(["email"]);
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [message, setMessage] = React.useState("");

  const [sending, setSending] = React.useState(false);
  const [regenerating, setRegenerating] = React.useState(false);
  const [outcomes, setOutcomes] = React.useState<Outcome[] | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${base}/send`, { cache: "no-store" });
      const j = await r.json();
      if (!j.success) throw new Error(j.error?.message ?? "Could not load this quotation.");
      const d = j.data as SendState;
      setState(d);
      setEmail(d.email ?? "");
      setPhone(d.phone ?? "");
      // Default to whatever the dealer actually has a contact for, so the
      // common case is one click.
      const next: Channel[] = [];
      if (d.email) next.push("email");
      if (d.phone) next.push("whatsapp");
      setChannels(next.length ? next : ["email"]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [base]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const toggle = (c: Channel) =>
    setChannels((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  async function regenerate() {
    setRegenerating(true);
    setError(null);
    try {
      const r = await fetch(`${base}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error?.message ?? "Could not generate the draft.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegenerating(false);
    }
  }

  async function send() {
    setSending(true);
    setError(null);
    setOutcomes(null);
    try {
      const r = await fetch(`${base}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channels,
          email: email.trim() || null,
          phone: phone.trim() || null,
          message: message.trim() || null,
        }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error?.message ?? "Could not send the quotation.");
      setOutcomes(j.data.outcomes as Outcome[]);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  const canSend =
    !!state?.sendable &&
    channels.length > 0 &&
    !sending &&
    (!channels.includes("email") || !!email.trim()) &&
    (!channels.includes("whatsapp") || !!phone.trim());

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Send quotation to dealer"
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-gray-100 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Send quotation to dealer</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {state?.quote_number ? (
                <span className="font-medium text-gray-700">{state.quote_number}</span>
              ) : (
                "No quotation number yet"
              )}
              {state?.dealer_name ? ` · ${state.dealer_name}` : ""}
              {state ? ` · v${state.version_no}` : ""}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading quotation…
            </div>
          ) : (
            <>
              {/* Why this cannot be sent, when it cannot. */}
              {state && !state.sendable && (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div>
                    {state.approval_status !== "approved" ? (
                      <>
                        This quotation is <b>{state.approval_status ?? "undecided"}</b>. Only an
                        approved quotation can be sent to a dealer.
                      </>
                    ) : (
                      <>
                        The quotation draft has not been generated yet.
                        {state.quote_pdf_error ? (
                          <span className="mt-1 block font-mono text-[10px] opacity-80">
                            {state.quote_pdf_error}
                          </span>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              )}

              {/*
                * E-243 — the dealer has already answered. Shown ABOVE the send
                * controls, not instead of them: a resend is still legitimate
                * (they asked for another copy), but nobody should chase a
                * dealer who has already replied without knowing they did.
                */}
              {state?.dealer_decision && (
                <div
                  className={`mb-4 rounded-lg border px-3 py-2.5 text-xs ${
                    state.dealer_decision === "approved"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                      : "border-slate-200 bg-slate-50 text-slate-700"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">
                      Dealer {state.dealer_decision === "approved" ? "approved" : "declined"}{" "}
                      this quotation
                    </span>
                    {state.dealer_decision_at && (
                      <span className="tabular-nums opacity-70">
                        {fmt(state.dealer_decision_at)}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 opacity-80">
                    via{" "}
                    {state.dealer_decision_via === "whatsapp"
                      ? "WhatsApp"
                      : "the approval link"}
                  </div>
                  {state.dealer_decision_note && (
                    <p className="mt-1.5 whitespace-pre-wrap opacity-90">
                      &ldquo;{state.dealer_decision_note}&rdquo;
                    </p>
                  )}
                </div>
              )}

              {/* The draft itself. */}
              <div className="mb-4 flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0 text-gray-400" />
                  <span className="truncate text-xs text-gray-700">
                    {state?.quote_pdf_url ? "Quotation draft" : "No draft yet"}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {state?.quote_pdf_url && (
                    <a
                      href={state.quote_pdf_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-medium text-blue-700 hover:underline"
                    >
                      Preview
                    </a>
                  )}
                  {state?.approval_status === "approved" && (
                    <button
                      onClick={regenerate}
                      disabled={regenerating}
                      className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3 w-3 ${regenerating ? "animate-spin" : ""}`} />
                      {state.quote_pdf_url ? "Regenerate" : "Generate"}
                    </button>
                  )}
                </div>
              </div>

              {/*
                * What the document commits us to, in front of whoever presses
                * Send. These print on the dealer's copy — including the deal
                * notes — and the send is the last point at which a wrong term
                * costs nothing to catch.
                */}
              {termRows.length > 0 && (
                <div className="mb-4 rounded-lg border border-gray-200 px-3 py-2.5">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    Terms on this quotation
                  </div>
                  <div className="space-y-0.5">
                    {termRows.map(([k, v]) => (
                      <div key={k} className="flex gap-2 text-xs">
                        <span className="w-24 shrink-0 text-gray-500">{k}</span>
                        <span className="min-w-0 flex-1 whitespace-pre-wrap text-gray-800">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Channels + recipients. */}
              <fieldset disabled={!state?.sendable} className="space-y-3 disabled:opacity-60">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => toggle("email")}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                      channels.includes("email")
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    <Mail className="h-3.5 w-3.5" /> Email
                  </button>
                  <button
                    type="button"
                    onClick={() => toggle("whatsapp")}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                      channels.includes("whatsapp")
                        ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                        : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
                  </button>
                </div>

                {channels.includes("email") && (
                  <label className="block">
                    <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-gray-500">
                      Dealer email
                    </span>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="dealer@example.com"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                    />
                    {!state?.email && (
                      <span className="mt-1 block text-[10px] text-gray-500">
                        No email on this lead yet — it will be saved once the send succeeds.
                      </span>
                    )}
                  </label>
                )}

                {channels.includes("whatsapp") && (
                  <label className="block">
                    <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-gray-500">
                      Dealer WhatsApp number
                    </span>
                    <input
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="+91 98765 43210"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                    />
                  </label>
                )}

                <label className="block">
                  <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-gray-500">
                    Covering note (optional)
                  </span>
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    rows={3}
                    placeholder="Leave blank to use the standard covering note."
                    className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                  />
                </label>
              </fieldset>

              {error && (
                <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                  {error}
                </div>
              )}

              {/* Per-channel result, so a partial send reads as partial. */}
              {outcomes && (
                <div className="mt-3 space-y-1.5">
                  {outcomes.map((o) => (
                    <div
                      key={o.channel}
                      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
                        o.status === "sent"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                          : "border-rose-200 bg-rose-50 text-rose-900"
                      }`}
                    >
                      {o.status === "sent" ? (
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <b className="capitalize">{o.channel}</b>{" "}
                        {o.status === "sent" ? `sent to ${o.recipient}` : "failed"}
                        {o.error ? <div className="opacity-80">{o.error}</div> : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Every previous attempt — a resend is a new row, never an edit. */}
              {!!state?.dispatches.length && (
                <div className="mt-5">
                  <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
                    Send history
                  </div>
                  <ul className="space-y-1">
                    {state.dispatches.map((d) => (
                      <li
                        key={d.dispatch_id}
                        className="flex items-center justify-between gap-2 rounded border border-gray-100 bg-gray-50/60 px-2 py-1 text-[11px]"
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                              d.status === "sent" ? "bg-emerald-500" : "bg-rose-500"
                            }`}
                          />
                          <span className="capitalize text-gray-700">{d.channel}</span>
                          <span className="truncate text-gray-500">{d.recipient}</span>
                        </span>
                        <span className="shrink-0 tabular-nums text-gray-400">
                          {fmt(d.created_at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-100"
          >
            Close
          </button>
          <button
            onClick={send}
            disabled={!canSend}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {sending ? "Sending…" : "Send to dealer"}
          </button>
        </div>
      </div>
    </div>
  );
}
