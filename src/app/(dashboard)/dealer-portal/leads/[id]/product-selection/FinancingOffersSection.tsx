"use client";

/**
 * Financing Offers — Addendum V0.2 §6.1/§6.2. Shows the firm offers the picked
 * NBFCs submitted for this finance lead and lets the dealer (customer-present)
 * select the winner. Selecting marks the chosen NBFC 'selected' and the others
 * 'not_selected', and advances the lead to the winner-only E-NACH stage.
 *
 * E-238 adds a Negotiate action alongside it: the dealer can ask a lender to
 * revise its offer instead of only taking or leaving it, until the NBFC fixes
 * the offer. Selecting a winner stays available throughout.
 *
 * E-245 makes that ask a plain message (the NBFC does the pricing) and adds
 * Close deal — the dealer walks away from one lender, with a mandatory note
 * explaining why. A closed card is terminal, and once anything on this lead is
 * closed the re-pick card below offers the remaining eligible lenders.
 *
 * Self-hides when the lead has no routed NBFCs (cash lead / not yet routed).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import OfferNegotiationThread from "@/components/nbfc-portal/OfferNegotiationThread";
import type { NegotiationRound } from "@/components/nbfc-portal/OfferNegotiationThread";
import OfferNegotiationPanel from "./OfferNegotiationPanel";
import type { NegotiationPanelMode } from "./OfferNegotiationPanel";
import ReselectFinancingCard from "./ReselectFinancingCard";

/**
 * The card claims "this updates as offers arrive", and until E-238 nothing ever
 * refetched — a dealer had to reload the page to see a new offer. A negotiation
 * is unusable that way, so the section polls while the tab is visible, matching
 * NotificationBell's pattern.
 */
const POLL_MS = 30_000;

type Offer = {
  roi_pct: string | null;
  emi_amount: string | null;
  tenure_months: number | null;
  loan_amount: string | null;
  down_payment: string | null;
  processing_fee: string | null;
  conditions: string | null;
  valid_until: string | null;
};

type Item = {
  nbfc_id: number;
  nbfc_id_code: string | null;
  nbfc_short_name: string | null;
  nbfc_legal_name: string | null;
  status: string;
  offer: Offer | null;
  negotiation_status: string | null;
  negotiation_round: number;
  fixed_at: string | null;
  negotiation: NegotiationRound[];
  /** E-161 ceo_approval_status when an offer exists but is withheld; else null. */
  withheld_reason: string | null;
};

type Resp = {
  success: boolean;
  data?: { leadId: string; kycStatus: string; winnerNbfcId: number | null; items: Item[] };
  error?: { message: string };
};

const inr = (v: string | null) =>
  v == null || v === "" ? "—" : `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

/** One-line terms for a collapsed (closed) card. */
const summarise = (o: Offer | null): string => {
  if (!o) return "No offer was submitted.";
  return (
    [
      o.loan_amount ? inr(o.loan_amount) : null,
      o.roi_pct ? `${o.roi_pct}%` : null,
      o.emi_amount ? `EMI ${inr(o.emi_amount)}` : null,
      o.tenure_months != null ? `${o.tenure_months} mo` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "—"
  );
};

export default function FinancingOffersSection({ leadId }: { leadId: string }) {
  const [data, setData] = useState<Resp["data"] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Which card has its message box open, and which action it is composing.
  // One at a time — two open boxes would both hold the poll off and let a
  // dealer type a negotiation into what they think is a close.
  const [composing, setComposing] = useState<{ nbfcId: number; mode: NegotiationPanelMode } | null>(
    null,
  );
  // A closed card collapses to a one-line summary. Nothing on it is actionable
  // any more, and left expanded — terms, close notice, and a multi-round history
  // — it buries the "choose another lender" card that is the whole point of
  // closing. Opt-in per card, and never sticky: re-closing the card also resets
  // the negotiation thread, since that unmounts with it.
  const [expandedClosed, setExpandedClosed] = useState<number[]>([]);
  // A poll that lands mid-edit would rebuild the form from fresh props and wipe
  // what the dealer typed. Held in a ref so the interval reads the live value
  // without being torn down and rebuilt on every keystroke.
  const dirtyRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/lead/${leadId}/offers`, { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (j.success && j.data) setData(j.data);
    } catch {
      /* non-fatal */
    } finally {
      setLoaded(true);
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while the tab is visible and nothing is being typed, and refetch
  // on focus so coming back to the tab is instant rather than up to POLL_MS old.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible" || dirtyRef.current) return;
      void load();
    };
    const timer = setInterval(refresh, POLL_MS);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  function toggleClosed(nbfcId: number) {
    setExpandedClosed((v) =>
      v.includes(nbfcId) ? v.filter((n) => n !== nbfcId) : [...v, nbfcId],
    );
  }

  const isComposing = (nbfcId: number, mode: NegotiationPanelMode) =>
    composing?.nbfcId === nbfcId && composing.mode === mode;

  /** Toggle one card's message box, clearing the dirty flag when it closes. */
  function toggleCompose(nbfcId: number, mode: NegotiationPanelMode) {
    setComposing((v) => {
      const next = v?.nbfcId === nbfcId && v.mode === mode ? null : { nbfcId, mode };
      if (next === null) dirtyRef.current = false;
      return next;
    });
  }

  async function pick(nbfcId: number) {
    setBusy(nbfcId);
    setError(null);
    try {
      const res = await fetch(`/api/lead/${leadId}/select-winner`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nbfcId }),
      });
      const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { message?: string } };
      if (!res.ok || j.success === false) throw new Error(j.error?.message ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function convertToCash() {
    const ok = await confirmDialog({
      title: "Convert to cash sale?",
      message: "Financing data will be purged and the lead reopens in cash mode.",
      confirmText: "Convert to cash",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(-1);
    setError(null);
    try {
      const res = await fetch(`/api/lead/${leadId}/switch-to-cash`, { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: { redirectTo?: string };
        error?: { message?: string };
      };
      if (!res.ok || j.success === false) throw new Error(j.error?.message ?? `HTTP ${res.status}`);
      window.location.href = j.data?.redirectTo ?? `/dealer-portal/leads/${leadId}/product-selection`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  if (!loaded || !data) return null;

  // §12 — terminal dead-end: offer the in-place cash conversion (Option A).
  if (data.kycStatus === "financing_unavailable") {
    return (
      <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-5">
        <h3 className="text-sm font-black uppercase tracking-wider text-amber-900">Financing Unavailable</h3>
        <p className="text-xs text-amber-800 mt-1 mb-4">
          All financing avenues for this lead were exhausted and an admin confirmed it as a dead-end.
          You can convert it to a cash sale in place, or leave it closed.
        </p>
        {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
        <button
          onClick={convertToCash}
          disabled={busy != null}
          className="px-4 py-2 rounded-lg bg-[color:var(--color-brand-navy)] text-white text-xs font-bold disabled:opacity-50"
        >
          {busy === -1 ? "Converting…" : "Convert to Cash Sale"}
        </button>
      </div>
    );
  }

  if (data.items.length === 0) return null;

  const decided = data.winnerNbfcId != null;
  const anyOffer = data.items.some((i) => i.offer != null);
  const anyClosed = data.items.some((i) => i.status === "withdrawn");
  // Section G caps a lead at 2 lenders; a closed one frees its slot.
  const liveCount = data.items.filter(
    (i) => !["withdrawn", "not_selected", "declined"].includes(i.status),
  ).length;

  return (
    <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-black uppercase tracking-wider text-slate-600">Financing Offers</h3>
        {decided && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-emerald-100 text-emerald-700">Winner selected</span>
        )}
      </div>
      <p className="text-xs text-slate-500 mb-4">
        {decided
          ? "The customer has selected a financing partner. The winning NBFC is now running E-NACH and agreement signing."
          : anyOffer
            ? "Compare the firm offers below with the customer. Send a message to ask a lender to revise its terms, select the winning lender — the others will be marked Not Selected — or delete the loan product to drop a lender and pick another."
            : "Waiting for the selected NBFCs to submit firm offers. This updates as offers arrive."}
      </p>

      {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data.items.map((item, idx) => {
          const isWinner = data.winnerNbfcId === item.nbfc_id;
          const isClosed = item.status === "withdrawn";
          const isLoser = decided && !isWinner;
          const isFixed = item.negotiation_status === "fixed";
          const awaitingNbfc = item.negotiation_status === "dealer_countered";
          // Actions live only on a live, offered card. A closed one drops out of
          // 'offer_submitted' on the server, so this goes false on its own.
          const isLive = !decided && item.offer != null && item.status === "offer_submitted";
          const canNegotiate = isLive && !isFixed;
          // Everything below the header is hidden on a closed card until asked for.
          const showDetail = !isClosed || expandedClosed.includes(item.nbfc_id);
          return (
            <div
              key={item.nbfc_id}
              className={`rounded-xl border ${isClosed && !showDetail ? "p-3" : "p-4"} ${
                isWinner
                  ? "border-emerald-300 bg-emerald-50/40"
                  : isClosed
                    ? "border-red-200 bg-red-50/30 opacity-80"
                    : isLoser
                      ? "border-slate-200 bg-slate-50 opacity-70"
                      : "border-slate-200"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-bold text-slate-800">
                    {`iTarang Scheme ${idx + 1} (${item.nbfc_id_code ?? `#${item.nbfc_id}`})`}
                  </div>
                </div>
                {isWinner && <span className="text-[10px] font-bold uppercase text-emerald-700">Selected</span>}
                {isClosed && (
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase text-red-700">
                    Product deleted
                  </span>
                )}
                {isLoser && !isClosed && (
                  <span className="text-[10px] font-bold uppercase text-slate-500">Not selected</span>
                )}
                {!decided && !isClosed && isFixed && (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700">
                    Fixed
                  </span>
                )}
                {!decided && !isClosed && awaitingNbfc && (
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold uppercase text-violet-700">
                    Awaiting NBFC
                  </span>
                )}
              </div>

              {/* Collapsed closed card: the terms on one line, so the dealer can
                  still tell two closed lenders apart at a glance. */}
              {isClosed && !showDetail && (
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[11px] text-slate-500">{summarise(item.offer)}</span>
                  <button
                    type="button"
                    onClick={() => toggleClosed(item.nbfc_id)}
                    className="text-[11px] font-semibold text-[color:var(--color-brand-sky)] hover:underline"
                  >
                    Show details
                  </button>
                </div>
              )}

              {showDetail &&
                (item.offer ? (
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  <O k="Loan" v={inr(item.offer.loan_amount)} />
                  <O k="ROI" v={item.offer.roi_pct ? `${item.offer.roi_pct}%` : "—"} />
                  <O k="EMI" v={inr(item.offer.emi_amount)} />
                  <O k="Tenure" v={item.offer.tenure_months != null ? `${item.offer.tenure_months} mo` : "—"} />
                  <O k="Down pmt" v={inr(item.offer.down_payment)} />
                  <O k="Proc. fee" v={inr(item.offer.processing_fee)} />
                  {item.offer.conditions && (
                    <div className="col-span-2 text-slate-600 mt-1">{item.offer.conditions}</div>
                  )}
                </dl>
              ) : item.withheld_reason ? (
                // The NBFC HAS submitted something, but E-161 is withholding it.
                // Distinct from "nothing submitted yet", and worth saying so the
                // dealer doesn't think the offer vanished mid-conversation.
                <p className="mt-3 rounded-md border border-amber-100 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                  {item.withheld_reason === "rejected"
                    ? "These terms were outside the approved band and the lender is re-pricing them."
                    : "Revised terms are under iTarang review."}
                  {item.negotiation.length > 1
                    ? " The history below still shows what was offered before."
                    : ""}
                </p>
              ) : (
                <p className="mt-3 text-xs text-slate-400">No offer submitted yet.</p>
                ))}

              {isClosed && showDetail && (
                <>
                  <p className="mt-2 text-[11px] text-red-700">
                    You deleted this loan product. This lender is out and cannot be selected — pick
                    another one below.
                  </p>
                  <button
                    type="button"
                    onClick={() => toggleClosed(item.nbfc_id)}
                    className="mt-1.5 text-[11px] font-semibold text-[color:var(--color-brand-sky)] hover:underline"
                  >
                    Hide details
                  </button>
                </>
              )}
              {!decided && !isClosed && isFixed && (
                <p className="mt-2 text-[11px] text-slate-500">
                  These terms are final. The NBFC has fixed this offer and it can no longer be
                  negotiated.
                </p>
              )}
              {!decided && !isClosed && awaitingNbfc && (
                <p className="mt-2 text-[11px] text-slate-500">
                  Your message has been sent. The NBFC will review it and revise the offer. You can
                  still select this lender on the terms above while you wait.
                </p>
              )}

              {isLive && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => pick(item.nbfc_id)}
                    disabled={busy != null}
                    className="flex-1 px-3 py-2 rounded-lg bg-[color:var(--color-brand-navy)] text-white text-xs font-bold disabled:opacity-50"
                  >
                    {busy === item.nbfc_id ? "Selecting…" : "Select as winner"}
                  </button>
                  {canNegotiate && (
                    <button
                      onClick={() => toggleCompose(item.nbfc_id, "negotiate")}
                      disabled={busy != null}
                      className="px-3 py-2 rounded-lg border border-[color:var(--color-brand-navy)] text-[color:var(--color-brand-navy)] text-xs font-bold disabled:opacity-50"
                    >
                      {isComposing(item.nbfc_id, "negotiate") ? "Cancel" : "Negotiate"}
                    </button>
                  )}
                  {/* Available even on a FIXED offer — fixing freezes the lender's
                      numbers, it does not oblige the customer to buy. */}
                  <button
                    onClick={() => toggleCompose(item.nbfc_id, "close")}
                    disabled={busy != null}
                    className="px-3 py-2 rounded-lg border border-red-300 text-red-700 text-xs font-bold disabled:opacity-50"
                  >
                    {isComposing(item.nbfc_id, "close") ? "Cancel" : "Delete loan product"}
                  </button>
                </div>
              )}

              {isLive && composing?.nbfcId === item.nbfc_id && (
                <OfferNegotiationPanel
                  leadId={leadId}
                  nbfcId={item.nbfc_id}
                  mode={composing.mode}
                  onDirtyChange={(d) => {
                    dirtyRef.current = d;
                  }}
                  onSent={async () => {
                    setComposing(null);
                    await load();
                  }}
                  onCancel={() => setComposing(null)}
                />
              )}

              {showDetail && (
                <OfferNegotiationThread rounds={item.negotiation} viewer="dealer" />
              )}
            </div>
          );
        })}
      </div>

      {/* E-245 — a closed deal frees a lender slot, so offer the remaining
          eligible loan products straight away rather than leaving the dealer on
          a card with nothing left to click. */}
      {!decided && anyClosed && (
        <ReselectFinancingCard
          leadId={leadId}
          assignedNbfcIds={data.items.map((i) => i.nbfc_id)}
          slotsFree={Math.max(0, 2 - liveCount)}
          onRouted={load}
        />
      )}
    </div>
  );
}

function O({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[9px] uppercase tracking-wider text-slate-400 font-bold">{k}</dt>
      <dd className="text-slate-700">{v}</dd>
    </div>
  );
}
