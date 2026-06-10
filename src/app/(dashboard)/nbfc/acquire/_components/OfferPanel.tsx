"use client";

/**
 * Financing Offer panel — Addendum V0.2 §6.1 (Stage 1). Credit / Underwriting
 * submits the firm financing conditions for this lead. Once the customer
 * (dealer-mediated) picks a winner the assignment locks and this becomes
 * read-only. Owned by the Credit / Underwriting role.
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
  // E-161 — out-of-band deviation gate (§13.3.4).
  ceo_approval_status?: string | null;
  deviation_reason?: string | null;
};

type Resp = {
  ok: boolean;
  assignment_status?: string;
  can_act?: boolean;
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

export default function OfferPanel({ leadId }: { leadId: string }) {
  const [data, setData] = useState<Resp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [edit, setEdit] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/nbfc/offer/${leadId}`);
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const offer = data?.offer ?? null;
  const status = data?.assignment_status ?? "pending";
  const canAct = data?.can_act ?? false;
  const decided = status === "selected" || status === "not_selected";

  // Every offer detail is mandatory (a real firm offer can't have blanks);
  // only Conditions/notes is optional. The numeric fields must carry a valid
  // number (0 is allowed, e.g. a ₹0 processing fee), and "Valid until" a date.
  const numericFilled = fields.every((f) => {
    const v = (form[f.key as string] ?? "").trim();
    return v !== "" && !Number.isNaN(Number(v));
  });
  const validUntilFilled = (form.valid_until ?? "").trim() !== "";
  const canSubmit = numericFilled && validUntilFilled && !busy;

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
        {offer?.ceo_approval_status === "pending" && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-amber-100 text-amber-700">Pending iTarang CEO approval</span>
        )}
        {offer?.ceo_approval_status === "rejected" && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-red-100 text-red-700">CEO rejected</span>
        )}
      </div>

      {error && <p className="text-[11px] text-red-600 mb-2">{error}</p>}

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

      {!offer && !edit && (
        <p className="text-xs text-slate-500">
          No firm offer submitted yet. {canAct ? "Submit one once verification is satisfactory." : "Credit / Underwriting will submit the firm conditions."}
        </p>
      )}

      {canAct && !decided && (edit || !offer) && (
        <div className="space-y-3 mt-1">
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
                  className="mt-1 w-full text-sm border border-slate-200 rounded-md px-2 py-1.5 font-normal"
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
              className="mt-1 w-full text-sm border border-slate-200 rounded-md px-2 py-1.5 font-normal"
            />
          </label>
          <label className="text-[11px] text-slate-500 font-semibold block">
            Valid until <span className="text-red-500">*</span>
            <input
              type="date"
              required
              value={form.valid_until ?? ""}
              onChange={(e) => setForm((s) => ({ ...s, valid_until: e.target.value }))}
              className="mt-1 w-full text-sm border border-slate-200 rounded-md px-2 py-1.5 font-normal"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={submit}
              disabled={!canSubmit}
              title={!canSubmit && !busy ? "Fill in all required offer details first" : undefined}
              className="px-3 py-1.5 rounded-md bg-[color:var(--color-brand-navy)] text-white text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? "Saving…" : offer ? "Resubmit offer" : "Submit offer"}
            </button>
            {offer && (
              <button onClick={() => setEdit(false)} disabled={busy} className="px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 text-xs font-semibold">
                Cancel
              </button>
            )}
            {!canSubmit && !busy && (
              <span className="text-[11px] text-slate-400">All fields except notes are required.</span>
            )}
          </div>
        </div>
      )}

      {canAct && !decided && offer && !edit && (
        <button onClick={() => setEdit(true)} className="mt-3 text-[11px] text-[color:var(--color-brand-sky)] underline">
          Edit / resubmit offer
        </button>
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
