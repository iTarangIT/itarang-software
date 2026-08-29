"use client";

/**
 * Financing Offers — Addendum V0.2 §6.1/§6.2. Shows the firm offer the picked
 * NBFC submitted for this finance lead and lets the dealer (customer-present)
 * accept it. Accepting marks the NBFC 'selected' and advances the lead to the
 * winner-only E-NACH stage.
 *
 * E-275 retired the dealer-side negotiation loop (Negotiate / Close deal). The
 * lender now approves or rejects directly. A rejection reaches the dealer only
 * once admin (or the SLA) forwards it — the card then turns red and the
 * "Choose another NBFC" re-pick card appears with the remaining eligible
 * lenders. Until it is forwarded, a declined assignment looks like any other
 * file under review.
 *
 * Self-hides when the lead has no routed NBFCs (cash lead / not yet routed /
 * Bajaj Finance external lender).
 */
import { useCallback, useEffect, useState } from "react";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import ReselectFinancingCard from "./ReselectFinancingCard";

/**
 * The card claims "this updates as offers arrive", so the section polls while
 * the tab is visible, matching NotificationBell's pattern.
 */
const POLL_MS = 30_000;

/** E-275 — one NBFC per lead. */
const MAX_LIVE_ASSIGNMENTS = 1;

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
  /** E-161 ceo_approval_status when an offer exists but is withheld; else null. */
  withheld_reason: string | null;
  /** E-275 — present only once admin / the SLA forwarded the rejection. */
  rejection_note: string | null;
  rejection_forwarded_at: string | null;
  decided_at: string | null;
};

type Resp = {
  success: boolean;
  data?: {
    leadId: string;
    kycStatus: string;
    winnerNbfcId: number | null;
    items: Item[];
    recalled_at: string | null;
    recall_note: string | null;
    resubmitted_at: string | null;
  };
  error?: { message: string };
};

const inr = (v: string | null) =>
  v == null || v === "" ? "—" : `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

const fmtDate = (v: string | null) => {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

/** E-275 — the dealer may only see a rejection once it has been forwarded. */
const isForwardedRejection = (i: Item) =>
  i.status === "declined" && !!i.rejection_forwarded_at;

const nbfcLabel = (i: Item) =>
  i.nbfc_short_name || i.nbfc_legal_name || i.nbfc_id_code || `NBFC #${i.nbfc_id}`;

export default function FinancingOffersSection({ leadId }: { leadId: string }) {
  const [data, setData] = useState<Resp["data"] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

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

  // Poll only while the tab is visible, and refetch on focus so coming back
  // to the tab is instant rather than up to POLL_MS old.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
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
  // A closed (withdrawn) or FORWARDED rejection frees the lead's single slot.
  const anyClosed = data.items.some((i) => i.status === "withdrawn" || isForwardedRejection(i));
  // A declined-but-not-forwarded assignment still counts as live here: it must
  // look like a file under review, and the slot is not free until forwarded.
  const liveCount = data.items.filter(
    (i) => !["withdrawn", "not_selected"].includes(i.status) && !isForwardedRejection(i),
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
          ? "The customer has accepted the offer. The NBFC is now running E-NACH and agreement signing."
          : anyOffer
            ? "Walk the customer through the firm offer below and accept it to proceed to E-NACH and agreement signing."
            : "Waiting for the NBFC to review the file and submit a firm offer. This updates as offers arrive."}
      </p>

      {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data.items.map((item, idx) => {
          const isWinner = data.winnerNbfcId === item.nbfc_id;
          const isClosed = item.status === "withdrawn";
          const isRejected = isForwardedRejection(item);
          const isLoser = decided && !isWinner;
          // Accept lives only on a live, offered card.
          const isLive = !decided && item.offer != null && item.status === "offer_submitted";
          const underReview =
            !decided && !isClosed && !isRejected && !isLoser && item.offer == null && !item.withheld_reason;
          return (
            <div
              key={item.nbfc_id}
              className={`rounded-xl border p-4 ${
                isWinner
                  ? "border-emerald-300 bg-emerald-50/40"
                  : isRejected
                    ? "border-red-300 bg-red-50/50"
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
                    {isRejected
                      ? `Rejected by ${nbfcLabel(item)}`
                      : `iTarang Scheme ${idx + 1} (${item.nbfc_id_code ?? `#${item.nbfc_id}`})`}
                  </div>
                </div>
                {isWinner && <span className="text-[10px] font-bold uppercase text-emerald-700">Selected</span>}
                {isRejected && (
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase text-red-700">
                    Rejected
                  </span>
                )}
                {isClosed && (
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase text-red-700">
                    Product deleted
                  </span>
                )}
                {isLoser && !isClosed && !isRejected && (
                  <span className="text-[10px] font-bold uppercase text-slate-500">Not selected</span>
                )}
                {underReview && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-700">
                    Under review
                  </span>
                )}
              </div>

              {isRejected ? (
                <div className="mt-3 rounded-md border border-red-200 bg-white px-3 py-2 text-xs text-red-800">
                  <span className="font-bold">Reason: </span>
                  {item.rejection_note || "No reason was provided."}
                  {item.rejection_forwarded_at && (
                    <span className="block mt-1 text-[10px] text-red-500">
                      Forwarded {fmtDate(item.rejection_forwarded_at)}
                    </span>
                  )}
                  <p className="mt-2 text-[11px] text-slate-600">
                    This lender is out. Choose another NBFC below to send the file again.
                  </p>
                </div>
              ) : item.offer ? (
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
                // dealer doesn't think the offer vanished.
                <p className="mt-3 rounded-md border border-amber-100 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                  {item.withheld_reason === "rejected"
                    ? "These terms were outside the approved band and the lender is re-pricing them."
                    : "The offer is under iTarang review."}
                </p>
              ) : (
                <p className="mt-3 text-xs text-slate-400">
                  {isClosed ? "No offer was submitted." : "The NBFC is reviewing the file. No offer submitted yet."}
                </p>
              )}

              {isClosed && (
                <p className="mt-2 text-[11px] text-red-700">
                  This lender is out and cannot be selected — pick another one below.
                </p>
              )}

              {isLive && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => pick(item.nbfc_id)}
                    disabled={busy != null}
                    className="flex-1 px-3 py-2 rounded-lg bg-[color:var(--color-brand-navy)] text-white text-xs font-bold disabled:opacity-50"
                  >
                    {busy === item.nbfc_id ? "Accepting…" : "Accept offer"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* E-275 — a forwarded rejection (or a closed deal) frees the lead's
          single lender slot, so offer the remaining eligible loan products
          straight away rather than leaving the dealer on a dead card. */}
      {!decided && anyClosed && (
        <ReselectFinancingCard
          leadId={leadId}
          assignedNbfcIds={data.items.map((i) => i.nbfc_id)}
          slotsFree={Math.max(0, MAX_LIVE_ASSIGNMENTS - liveCount)}
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
