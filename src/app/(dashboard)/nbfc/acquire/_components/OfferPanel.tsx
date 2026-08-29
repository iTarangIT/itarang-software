"use client";

/**
 * Financing Offer panel — Addendum V0.2 §6.1 (Stage 1). Credit / Underwriting
 * submits the firm financing conditions for this lead. Once the customer
 * (dealer-mediated) picks a winner the assignment locks and this becomes
 * read-only. Owned by the Credit / Underwriting role.
 *
 * E-275 — the offer is PREFILLED from the indicated loan product (best terms
 * at the customer's requested amount) and the officer has three moves:
 * Approve & send (POST as-is), Edit (unlock the fields, then Send), or Reject
 * the file (required note → the rejection waits with the iTarang admin). The
 * E-238/E-245 dealer ⇄ NBFC negotiation loop and Fix lock are gone.
 */
import { useCallback, useEffect, useState } from "react";

type Offer = {
  roi_pct: string | null;
  emi_amount: string | null;
  tenure_months: number | null;
  loan_amount: string | null;
  down_payment: string | null;
  processing_fee: string | null;
  conditions: string | null;
  valid_until: string | null;
  submitted_at: string | null;
  status?: string | null;
  // E-161 — out-of-band deviation gate (§13.3.4).
  ceo_approval_status?: string | null;
  deviation_reason?: string | null;
};

type Defaults = {
  product_name: string;
  loan_amount: number;
  roi_pct: number;
  tenure_months: number;
  down_payment: number;
  processing_fee: number;
  emi_amount: number;
};

type Resp = {
  ok: boolean;
  assignment_status?: string;
  can_act?: boolean;
  recalled?: boolean;
  rejection_note?: string | null;
  defaults?: Defaults | null;
  offer?: Offer | null;
  error?: string;
};

const fields: { key: keyof Offer; label: string; type: string; placeholder: string }[] = [
  { key: "loan_amount", label: "Loan amount (₹)", type: "number", placeholder: "120000" },
  { key: "roi_pct", label: "ROI (%)", type: "number", placeholder: "18.5" },
  { key: "emi_amount", label: "EMI (₹)", type: "number", placeholder: "4500" },
  { key: "tenure_months", label: "Tenure (months)", type: "number", placeholder: "36" },
  { key: "down_payment", label: "Down payment (₹)", type: "number", placeholder: "15000" },
  { key: "processing_fee", label: "Processing fee (₹)", type: "number", placeholder: "2500" },
];

/** Server errors arrive prefixed with their internal code; strip it for display. */
const clean = (msg: string) => msg.replace(/^[A-Z_]+:\s*/, "");

/** Default validity: 30 days out, as yyyy-mm-dd for the date input. */
function defaultValidUntil(): string {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

export default function OfferPanel({
  leadId,
  disabled = false,
}: {
  leadId: string;
  /** E-275 — the file is recalled by iTarang; every action is paused. */
  disabled?: boolean;
}) {
  const [data, setData] = useState<Resp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [edit, setEdit] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/nbfc/offer/${leadId}`, { cache: "no-store" });
      const j = (await res.json()) as Resp;
      setData(j);
      if (j.offer) {
        setForm({
          loan_amount: j.offer.loan_amount ?? "",
          roi_pct: j.offer.roi_pct ?? "",
          emi_amount: j.offer.emi_amount ?? "",
          tenure_months: j.offer.tenure_months != null ? String(j.offer.tenure_months) : "",
          down_payment: j.offer.down_payment ?? "",
          processing_fee: j.offer.processing_fee ?? "",
          conditions: j.offer.conditions ?? "",
          valid_until: j.offer.valid_until ?? "",
        });
      } else if (j.defaults) {
        // E-275 — prefill from the indicated loan product.
        setForm({
          loan_amount: String(j.defaults.loan_amount),
          roi_pct: String(j.defaults.roi_pct),
          emi_amount: String(j.defaults.emi_amount),
          tenure_months: String(j.defaults.tenure_months),
          down_payment: String(j.defaults.down_payment),
          processing_fee: String(j.defaults.processing_fee),
          conditions: "",
          valid_until: defaultValidUntil(),
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/offer/${leadId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          loan_amount: form.loan_amount || null,
          roi_pct: form.roi_pct || null,
          emi_amount: form.emi_amount || null,
          tenure_months: form.tenure_months || null,
          down_payment: form.down_payment || null,
          processing_fee: form.processing_fee || null,
          conditions: form.conditions || null,
          valid_until: form.valid_until || null,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      setEdit(false);
      await load();
    } catch (e) {
      setError(clean(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    const note = rejectNote.trim();
    if (!note) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/acquire/${leadId}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      setRejecting(false);
      // The stepper is server-rendered; reload so the Offer node reads Rejected.
      window.location.reload();
    } catch (e) {
      setError(clean(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  const offer = data?.offer ?? null;
  const defaults = data?.defaults ?? null;
  const status = data?.assignment_status ?? "pending";
  const recalled = disabled || (data?.recalled ?? false);
  const canAct = (data?.can_act ?? false) && !recalled;
  const decided = status === "selected" || status === "not_selected";
  const closedByDealer = status === "withdrawn";
  const rejected = status === "declined";
  const pristine = !offer && !edit; // the prefilled, not-yet-sent state

  // Every offer detail is mandatory (a real firm offer can't have blanks);
  // only Conditions/notes is optional. The numeric fields must carry a valid
  // number (0 is allowed, e.g. a ₹0 processing fee), and "Valid until" a date.
  const numericFilled = fields.every((f) => {
    const v = (form[f.key as string] ?? "").trim();
    return v !== "" && !Number.isNaN(Number(v));
  });
  const validUntilFilled = (form.valid_until ?? "").trim() !== "";
  const canSubmit = numericFilled && validUntilFilled && !busy;

  const inputCls =
    "mt-1 w-full text-sm border border-slate-200 rounded-md px-2 py-1.5 font-normal disabled:bg-slate-50 disabled:text-slate-500";

  return (
    <section className="border border-slate-200 rounded-xl bg-white p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">Financing Offer</h2>
        {status === "offer_submitted" && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-sky-100 text-sky-700">Submitted</span>
        )}
        {status === "selected" && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-emerald-100 text-emerald-700">Won</span>
        )}
        {status === "not_selected" && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-slate-200 text-slate-600">Not selected</span>
        )}
        {closedByDealer && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-red-100 text-red-700">Deal closed by customer</span>
        )}
        {rejected && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-red-100 text-red-700">Rejected</span>
        )}
        {offer?.ceo_approval_status === "pending" && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-amber-100 text-amber-700">Pending iTarang CEO approval</span>
        )}
        {offer?.ceo_approval_status === "rejected" && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-red-100 text-red-700">CEO rejected</span>
        )}
      </div>

      {error && <p className="text-[11px] text-red-600 mb-2">{error}</p>}

      {recalled && !rejected && (
        <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-2">
          Recalled by iTarang — changes are being made to this file. Actions are paused until it is resubmitted.
        </p>
      )}

      {rejected && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50/60 p-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-red-800">File rejected by this NBFC</p>
          {data?.rejection_note ? (
            <p className="mt-2 whitespace-pre-line rounded-md bg-white/70 px-2.5 py-1.5 text-sm text-slate-700">
              {data.rejection_note}
            </p>
          ) : null}
          <p className="mt-2 text-[11px] text-red-700">
            iTarang will relay the reason to the dealer, who may route the customer to another lender. No further action.
          </p>
        </div>
      )}

      {offer?.ceo_approval_status === "pending" && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-md px-3 py-2 mb-2">
          This offer is outside the product band{offer.deviation_reason ? ` (${offer.deviation_reason})` : ""} and is held for iTarang CEO approval before the customer can see it.
        </p>
      )}
      {offer?.ceo_approval_status === "rejected" && (
        <p className="text-[11px] text-red-700 bg-red-50 border border-red-100 rounded-md px-3 py-2 mb-2">
          The iTarang CEO rejected this out-of-band offer{offer.deviation_reason ? ` (${offer.deviation_reason})` : ""}. Revise the terms within band and resubmit.
        </p>
      )}

      {/* E-245 — the dealer closed the deal. Terminal; nothing below is actionable. */}
      {closedByDealer && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50/60 p-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-red-800">Deal closed by customer</p>
          <p className="mt-2 text-[11px] text-red-700">
            This offer is withdrawn and can no longer be revised. The lead may be routed to another lender.
          </p>
        </div>
      )}

      {/* A submitted offer — read-only terms. */}
      {offer && !edit && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <Row k="Loan amount" v={offer.loan_amount} prefix="₹" />
          <Row k="ROI" v={offer.roi_pct} suffix="%" />
          <Row k="EMI" v={offer.emi_amount} prefix="₹" />
          <Row k="Tenure" v={offer.tenure_months != null ? String(offer.tenure_months) : null} suffix=" mo" />
          <Row k="Down payment" v={offer.down_payment} prefix="₹" />
          <Row k="Processing fee" v={offer.processing_fee} prefix="₹" />
          {offer.conditions && (
            <div className="col-span-2">
              <dt className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Conditions</dt>
              <dd className="text-sm text-slate-700 mt-0.5 whitespace-pre-wrap">{offer.conditions}</dd>
            </div>
          )}
        </dl>
      )}

      {/* E-275 — no offer yet and no product to prefill from. */}
      {pristine && !defaults && !rejected && (
        <p className="text-xs text-slate-500">
          No loan product is pinned to this lead, so the offer cannot be prefilled.{" "}
          {canAct ? "Enter the firm conditions below." : "Credit / Underwriting will submit the firm conditions."}
        </p>
      )}

      {/* E-275 — the prefilled summary card: Approve / Edit / Reject. */}
      {pristine && defaults && !rejected && !closedByDealer && (
        <div className="rounded-lg border border-sky-200 bg-sky-50/40 p-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-sky-800">
            Loan product: <span className="normal-case tracking-normal text-slate-800">{defaults.product_name}</span>
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Prefilled at the product&apos;s best terms for the customer&apos;s requested amount. Approve to send as-is, or edit first.
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <Row k="Loan amount" v={form.loan_amount ?? null} prefix="₹" />
            <Row k="ROI" v={form.roi_pct ?? null} suffix="%" />
            <Row k="EMI" v={form.emi_amount ?? null} prefix="₹" />
            <Row k="Tenure" v={form.tenure_months ?? null} suffix=" mo" />
            <Row k="Down payment" v={form.down_payment ?? null} prefix="₹" />
            <Row k="Processing fee" v={form.processing_fee ?? null} prefix="₹" />
            <Row k="Valid until" v={form.valid_until ?? null} />
          </dl>
          {canAct && !rejecting && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={submit}
                disabled={!canSubmit}
                className="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy ? "Sending…" : "Approve & send offer"}
              </button>
              <button
                onClick={() => setEdit(true)}
                disabled={busy}
                className="px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 text-xs font-semibold"
              >
                Edit
              </button>
              <button
                onClick={() => setRejecting(true)}
                disabled={busy}
                className="ml-auto px-3 py-1.5 rounded-md border border-red-300 bg-red-50 text-red-700 text-xs font-semibold hover:bg-red-100"
              >
                Reject
              </button>
            </div>
          )}
        </div>
      )}

      {/* The editable form — Edit on the prefilled card, no product to prefill
          from, or revising a submitted offer. */}
      {canAct && !decided && !rejected && !closedByDealer && (edit || (!offer && !defaults)) && (
        <div className="space-y-3 mt-3">
          <div className="grid grid-cols-2 gap-3">
            {fields.map((f) => (
              <label key={f.key} className="text-[11px] text-slate-500 font-semibold">
                {f.label} <span className="text-red-500">*</span>
                <input
                  type={f.type}
                  required
                  value={form[f.key] ?? ""}
                  onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  className={inputCls}
                />
              </label>
            ))}
          </div>
          <label className="text-[11px] text-slate-500 font-semibold block">
            Conditions / notes <span className="text-slate-400 font-normal">(optional)</span>
            <textarea
              value={form.conditions ?? ""}
              onChange={(e) => setForm((s) => ({ ...s, conditions: e.target.value }))}
              rows={2}
              placeholder="Any firm conditions attached to this offer…"
              className={inputCls}
            />
          </label>
          <label className="text-[11px] text-slate-500 font-semibold block">
            Valid until <span className="text-red-500">*</span>
            <input
              type="date"
              required
              value={form.valid_until ?? ""}
              onChange={(e) => setForm((s) => ({ ...s, valid_until: e.target.value }))}
              className={inputCls}
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={submit}
              disabled={!canSubmit}
              title={!canSubmit && !busy ? "Fill in all required offer details first" : undefined}
              className="px-3 py-1.5 rounded-md bg-[color:var(--color-brand-navy)] text-white text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? "Saving…" : offer ? "Resubmit offer" : "Send offer"}
            </button>
            {(offer || defaults) && (
              <button onClick={() => setEdit(false)} disabled={busy} className="px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 text-xs font-semibold">
                Cancel
              </button>
            )}
            {!rejecting && !offer && (
              <button
                onClick={() => setRejecting(true)}
                disabled={busy}
                className="ml-auto px-3 py-1.5 rounded-md border border-red-300 bg-red-50 text-red-700 text-xs font-semibold hover:bg-red-100"
              >
                Reject
              </button>
            )}
            {!canSubmit && !busy && (
              <span className="text-[11px] text-slate-400">All fields except notes are required.</span>
            )}
          </div>
        </div>
      )}

      {canAct && !decided && !rejected && offer && !edit && (
        <div className="mt-3 flex items-center gap-3">
          <button onClick={() => setEdit(true)} className="text-[11px] text-[color:var(--color-brand-sky)] underline">
            Edit / resubmit offer
          </button>
          {!rejecting && (
            <button
              onClick={() => setRejecting(true)}
              disabled={busy}
              className="ml-auto rounded-md border border-red-300 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
            >
              Reject file
            </button>
          )}
        </div>
      )}

      {/* E-275 — rejection needs a reason; it is what the dealer will be told. */}
      {rejecting && canAct && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50/60 p-3">
          <label className="block text-[11px] font-semibold text-red-800">
            Reason for rejecting this file <span className="text-red-500">*</span>
            <textarea
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="e.g. Bureau score below policy; income proof insufficient for the requested amount…"
              className="mt-1 w-full rounded-md border border-red-200 bg-white px-2 py-1.5 text-sm font-normal text-slate-800"
            />
          </label>
          <p className="mt-1 text-[11px] text-red-700">
            This reason goes to iTarang, who relays it to the dealer so the customer can choose another NBFC. It cannot be undone.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <button
              onClick={() => {
                setRejecting(false);
                setRejectNote("");
              }}
              disabled={busy}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700"
            >
              Cancel
            </button>
            <button
              onClick={reject}
              disabled={busy || rejectNote.trim().length === 0}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
            >
              {busy ? "Rejecting…" : "Reject file"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Row({ k, v, prefix, suffix }: { k: string; v: string | null; prefix?: string; suffix?: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">{k}</dt>
      <dd className="text-sm text-slate-700 mt-0.5">
        {v == null || v === "" ? <span className="text-slate-300">—</span> : `${prefix ?? ""}${v}${suffix ?? ""}`}
      </dd>
    </div>
  );
}
