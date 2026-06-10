"use client";

/**
 * One pending out-of-band financing-offer deviation awaiting iTarang CEO sign-off
 * (BRD Addendum V0.3.1 §13.3.4). Shows the deviating terms, a 4-hour SLA
 * countdown, and approve/reject controls. Mobile-friendly (single column).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

export type DeviationRequest = {
  id: string;
  leadId: string | null;
  nbfcName: string | null;
  createdAt: string | null;
  deviationReason: string | null;
  offer: {
    loan_amount: string | null;
    roi_pct: string | null;
    emi_amount: string | null;
    tenure_months: number | string | null;
    down_payment: string | null;
  } | null;
};

const SLA_HOURS = 4;

function slaLabel(createdAt: string | null): { text: string; breached: boolean } {
  if (!createdAt) return { text: "—", breached: false };
  const due = new Date(createdAt).getTime() + SLA_HOURS * 60 * 60 * 1000;
  const ms = due - Date.now();
  if (ms <= 0) return { text: `SLA breached ${Math.floor(-ms / 3_600_000)}h ago`, breached: true };
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return { text: `${h}h ${m}m to SLA`, breached: false };
}

export default function FinancingOfferDeviationCard({ req }: { req: DeviationRequest }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const sla = slaLabel(req.createdAt);

  async function act(path: "approve" | "reject", body?: object) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/nbfc/financing-offers/approvals/${req.id}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const o = req.offer;
  return (
    <div className="card-iTarang p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-[color:var(--color-brand-navy)]">{req.nbfcName ?? "NBFC"}</p>
          <p className="text-xs text-slate-500">Lead {req.leadId ?? "—"}</p>
        </div>
        <span
          className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded ${
            sla.breached ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"
          }`}
        >
          {sla.text}
        </span>
      </div>

      <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-md px-3 py-2">
        {req.deviationReason ?? "Out-of-band financing offer"}
      </p>

      {o && (
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
          <Field k="Loan amount" v={o.loan_amount} prefix="₹" />
          <Field k="ROI" v={o.roi_pct} suffix="%" />
          <Field k="EMI" v={o.emi_amount} prefix="₹" />
          <Field k="Tenure" v={o.tenure_months != null ? String(o.tenure_months) : null} suffix=" mo" />
          <Field k="Down payment" v={o.down_payment} prefix="₹" />
        </dl>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}

      {!rejecting ? (
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={() => act("approve")}
            disabled={busy}
            className="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-semibold disabled:opacity-50"
          >
            {busy ? "Working…" : "Approve"}
          </button>
          <button
            onClick={() => setRejecting(true)}
            disabled={busy}
            className="px-3 py-1.5 rounded-md border border-red-300 text-red-700 text-xs font-semibold disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      ) : (
        <div className="space-y-2 pt-1">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Reason for rejection (required)…"
            className="w-full text-sm border border-slate-200 rounded-md px-2 py-1.5"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => act("reject", { rejection_reason: reason })}
              disabled={busy || reason.trim().length < 3}
              className="px-3 py-1.5 rounded-md bg-red-600 text-white text-xs font-semibold disabled:opacity-50"
            >
              Confirm reject
            </button>
            <button
              onClick={() => setRejecting(false)}
              disabled={busy}
              className="px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 text-xs font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ k, v, prefix, suffix }: { k: string; v: string | null; prefix?: string; suffix?: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">{k}</dt>
      <dd className="text-sm text-slate-700 mt-0.5">
        {v == null || v === "" ? <span className="text-slate-300">—</span> : `${prefix ?? ""}${v}${suffix ?? ""}`}
      </dd>
    </div>
  );
}
