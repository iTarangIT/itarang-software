"use client";

/**
 * E-243 — the dealer's quotation response page. PUBLIC, no login.
 *
 * Opened from the "Review & respond" button in the quotation email, or from the
 * link in the WhatsApp caption. The dealer reads the document we already sent
 * them and answers once.
 *
 * ## Why a page and not an email reply
 *
 * Parsing replies means guessing what "ok" meant, and there is no inbound mail
 * route in this app to parse them with. A click is unambiguous, works from any
 * mail client on any device, and leaves the same signed audit trail whichever
 * channel the dealer came from.
 *
 * ## Mobile first
 *
 * Dealers open this on a phone, from WhatsApp, on a bad connection. One column,
 * large touch targets, no framework chrome, and the document itself is a link
 * out rather than an embedded viewer — an inline PDF on a mid-range Android is
 * how you lose the response.
 *
 * ## Declining asks for a reason, approving does not
 *
 * A decline is the one the sales manager has to act on, and "why" is the whole
 * content of that action. It is still optional: a dealer who will not type is a
 * dealer whose answer we would rather have than not.
 */
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

interface QuoteContext {
  quote_number: string | null;
  dealer_name: string | null;
  value: number;
  pdf_url: string | null;
  open: boolean;
  decision: "approved" | "declined" | null;
  decided_at: string | null;
  withdrawn: boolean;
}

type Phase = "loading" | "ready" | "submitting" | "done" | "unavailable";

function inr(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  return `₹${n.toLocaleString("en-IN")}`;
}

export default function QuoteResponsePage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";

  const [ctx, setCtx] = useState<QuoteContext | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<"approved" | "declined" | null>(null);
  const [repeat, setRepeat] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    // setState calls live inside this async function, not synchronously in the
    // effect body — the house pattern (cf. AdminBuybackSearch's `run()`), which
    // keeps react-hooks/set-state-in-effect happy.
    const run = async () => {
      try {
        const r = await fetch(`/api/public/quotations/${token}`, { cache: "no-store" });
        const j = await r.json();
        if (cancelled) return;
        if (!j.success) {
          setError(j.error?.message ?? "This link is not valid.");
          setPhase("unavailable");
          return;
        }
        const d = j.data as QuoteContext;
        setCtx(d);
        if (d.decision) {
          // They have already answered — show it back rather than inviting a
          // second response the server would refuse anyway.
          setOutcome(d.decision);
          setRepeat(true);
          setPhase("done");
        } else if (!d.open) {
          setPhase("unavailable");
        } else {
          setPhase("ready");
        }
      } catch {
        if (cancelled) return;
        setError("Couldn't reach the server. Please check your connection.");
        setPhase("unavailable");
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function respond(decision: "approved" | "declined") {
    setPhase("submitting");
    setError(null);
    try {
      const r = await fetch(`/api/public/quotations/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: note.trim() || null }),
      });
      const j = await r.json();
      if (!j.success) {
        setError(j.error?.message ?? "Couldn't record your response.");
        setPhase("ready");
        return;
      }
      setOutcome(j.data.decision);
      setRepeat(!!j.data.repeat);
      setPhase("done");
    } catch {
      setError("Couldn't reach the server. Please try again.");
      setPhase("ready");
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 flex justify-center">
      <div className="w-full max-w-md">
        <header className="mb-6 text-center">
          <h1 className="text-lg font-bold tracking-tight text-slate-900">
            iTarang Technologies LLP
          </h1>
          <p className="mt-0.5 text-xs text-slate-500">Quotation for your approval</p>
        </header>

        {phase === "loading" && (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            Loading your quotation…
          </div>
        )}

        {phase === "unavailable" && (
          <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center">
            <p className="text-sm font-semibold text-slate-900">
              This quotation isn&apos;t open for a response
            </p>
            <p className="mt-1.5 text-xs text-slate-500">
              {error ??
                (ctx?.withdrawn
                  ? "It has been withdrawn or revised. Your iTarang contact can send you the current one."
                  : "Please contact your iTarang representative.")}
            </p>
          </div>
        )}

        {(phase === "ready" || phase === "submitting") && ctx && (
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            <div className="border-b border-slate-100 px-5 py-4">
              {ctx.dealer_name && (
                <p className="text-sm font-semibold text-slate-900">{ctx.dealer_name}</p>
              )}
              <div className="mt-1 flex items-baseline justify-between gap-3">
                <span className="font-mono text-xs text-slate-500">
                  {ctx.quote_number ?? "Quotation"}
                </span>
                {inr(ctx.value) && (
                  <span className="text-xl font-bold tabular-nums text-slate-900">
                    {inr(ctx.value)}
                  </span>
                )}
              </div>
            </div>

            {ctx.pdf_url && (
              <a
                href={ctx.pdf_url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5 text-sm font-semibold text-blue-700 active:bg-slate-50"
              >
                View the full quotation
                <span aria-hidden>↗</span>
              </a>
            )}

            <div className="px-5 py-5">
              {!declining ? (
                <>
                  <p className="mb-4 text-center text-xs text-slate-500">
                    Please review the quotation above and let us know.
                  </p>
                  <button
                    onClick={() => respond("approved")}
                    disabled={phase === "submitting"}
                    className="w-full rounded-xl bg-emerald-600 py-3.5 text-sm font-bold text-white active:bg-emerald-700 disabled:opacity-50"
                  >
                    {phase === "submitting" ? "Sending…" : "Approve this quotation"}
                  </button>
                  <button
                    onClick={() => setDeclining(true)}
                    disabled={phase === "submitting"}
                    className="mt-2 w-full rounded-xl border border-slate-200 py-3 text-sm font-semibold text-slate-600 active:bg-slate-50 disabled:opacity-50"
                  >
                    Not right now
                  </button>
                </>
              ) : (
                <>
                  <label className="mb-1.5 block text-xs font-medium text-slate-600">
                    Anything you&apos;d like to tell us? (optional)
                  </label>
                  <textarea
                    autoFocus
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={3}
                    maxLength={1000}
                    placeholder="e.g. the price is higher than expected"
                    className="w-full resize-none rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-slate-500"
                  />
                  <button
                    onClick={() => respond("declined")}
                    disabled={phase === "submitting"}
                    className="mt-3 w-full rounded-xl bg-slate-800 py-3.5 text-sm font-bold text-white active:bg-slate-900 disabled:opacity-50"
                  >
                    {phase === "submitting" ? "Sending…" : "Send response"}
                  </button>
                  <button
                    onClick={() => setDeclining(false)}
                    disabled={phase === "submitting"}
                    className="mt-2 w-full py-2 text-xs font-semibold text-slate-500"
                  >
                    Back
                  </button>
                </>
              )}

              {error && (
                <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  {error}
                </p>
              )}
            </div>
          </div>
        )}

        {phase === "done" && (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <div
              className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full text-2xl ${
                outcome === "approved"
                  ? "bg-emerald-50 text-emerald-600"
                  : "bg-slate-100 text-slate-500"
              }`}
              aria-hidden
            >
              {outcome === "approved" ? "✓" : "•"}
            </div>
            <p className="mt-3 text-sm font-semibold text-slate-900">
              {outcome === "approved"
                ? "Thank you — your approval is recorded."
                : "Thank you — your response is recorded."}
            </p>
            <p className="mt-1.5 text-xs text-slate-500">
              {repeat
                ? "You had already responded to this quotation, so nothing has changed."
                : outcome === "approved"
                  ? "Your iTarang representative will be in touch to take it forward."
                  : "Your iTarang representative will follow up with you."}
            </p>
            {ctx?.quote_number && (
              <p className="mt-3 font-mono text-[11px] text-slate-400">{ctx.quote_number}</p>
            )}
          </div>
        )}

        <p className="mt-6 text-center text-[11px] text-slate-400">
          Sent by iTarang Technologies LLP · care.itarang@gmail.com
        </p>
      </div>
    </main>
  );
}
