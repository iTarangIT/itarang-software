"use client";

/**
 * Financing Offers — Addendum V0.2 §6.1/§6.2. Shows the firm offers the picked
 * NBFCs submitted for this finance lead and lets the dealer (customer-present)
 * select the winner. Selecting marks the chosen NBFC 'selected' and the others
 * 'not_selected', and advances the lead to the winner-only E-NACH stage.
 *
 * E-238 adds a Negotiate action alongside it: the dealer can counter an offer
 * with specific terms instead of only taking or leaving it, until the NBFC
 * fixes the offer. Selecting a winner stays available throughout.
 *
 * Self-hides when the lead has no routed NBFCs (cash lead / not yet routed).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import OfferNegotiationThread from "@/components/nbfc-portal/OfferNegotiationThread";
import type { NegotiationRound } from "@/components/nbfc-portal/OfferNegotiationThread";
import OfferNegotiationPanel from "./OfferNegotiationPanel";

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

export default function FinancingOffersSection({ leadId }: { leadId: string }) {
  const [data, setData] = useState<Resp["data"] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [negotiating, setNegotiating] = useState<number | null>(null);
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
            ? "Compare the firm offers below with the customer. Negotiate to ask a lender for revised terms, or select the winning lender — the others will be marked Not Selected."
            : "Waiting for the selected NBFCs to submit firm offers. This updates as offers arrive."}
      </p>

      {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data.items.map((item, idx) => {
          const isWinner = data.winnerNbfcId === item.nbfc_id;
          const isLoser = decided && !isWinner;
          const isFixed = item.negotiation_status === "fixed";
          const awaitingNbfc = item.negotiation_status === "dealer_countered";
          const canNegotiate =
            !decided && item.offer != null && item.status === "offer_submitted" && !isFixed;
          return (
            <div
              key={item.nbfc_id}
              className={`rounded-xl border p-4 ${
                isWinner
                  ? "border-emerald-300 bg-emerald-50/40"
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
                {isLoser && <span className="text-[10px] font-bold uppercase text-slate-500">Not selected</span>}
                {!decided && isFixed && (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700">
                    Fixed
                  </span>
                )}
                {!decided && awaitingNbfc && (
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold uppercase text-violet-700">
                    Awaiting NBFC
                  </span>
                )}
              </div>

              {item.offer ? (
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
              )}

              {!decided && isFixed && (
                <p className="mt-2 text-[11px] text-slate-500">
                  These terms are final. The NBFC has fixed this offer and it can no longer be
                  negotiated.
                </p>
              )}
              {!decided && awaitingNbfc && (
                <p className="mt-2 text-[11px] text-slate-500">
                  Your counter-offer has been sent. You can still select this lender on the terms
                  above while you wait.
                </p>
              )}

              {!decided && item.offer && item.status === "offer_submitted" && (
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => pick(item.nbfc_id)}
                    disabled={busy != null}
                    className="flex-1 px-3 py-2 rounded-lg bg-[color:var(--color-brand-navy)] text-white text-xs font-bold disabled:opacity-50"
                  >
                    {busy === item.nbfc_id ? "Selecting…" : "Select as winner"}
                  </button>
                  {canNegotiate && (
                    <button
                      onClick={() =>
                        setNegotiating((v) => (v === item.nbfc_id ? null : item.nbfc_id))
                      }
                      disabled={busy != null}
                      className="px-3 py-2 rounded-lg border border-[color:var(--color-brand-navy)] text-[color:var(--color-brand-navy)] text-xs font-bold disabled:opacity-50"
                    >
                      {negotiating === item.nbfc_id ? "Close" : "Negotiate"}
                    </button>
                  )}
                </div>
              )}

              {canNegotiate && negotiating === item.nbfc_id && item.offer && (
                <OfferNegotiationPanel
                  leadId={leadId}
                  nbfcId={item.nbfc_id}
                  offer={item.offer}
                  onDirtyChange={(d) => {
                    dirtyRef.current = d;
                  }}
                  onSent={async () => {
                    setNegotiating(null);
                    await load();
                  }}
                  onCancel={() => setNegotiating(null)}
                />
              )}

              <OfferNegotiationThread rounds={item.negotiation} viewer="dealer" />
            </div>
          );
        })}
      </div>
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
