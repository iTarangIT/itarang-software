"use client";

/**
 * E-245 — pick another lender after closing a deal.
 *
 * Reads the SAME BRE-matched list Section G renders at Step 4
 * (GET /api/lead/[id]/section-g-options), so the dealer sees the loan products
 * they were originally choosing between rather than a second, divergent list.
 * Lenders already on this lead are filtered out: the one just closed is out for
 * good, and re-adding any of them would collide with the unique
 * (lead_id, nbfc_id) index anyway.
 *
 * Deliberately NOT a re-opening of Step 4. The wizard is read-only once
 * submitted; the only thing changing here is which lender gets the application.
 */
import { useCallback, useEffect, useState } from "react";

import { confirmDialog } from "@/components/ui/confirm-dialog";

type LoanProduct = {
  id: number;
  productName: string;
  loanAmountMin: number;
  loanAmountMax: number;
  tenureMonthsMin: number;
  tenureMonthsMax: number;
  minRoiPct: string;
  maxRoiPct: string;
  downPaymentPct: string;
};

type NbfcGroup = {
  nbfcId: number;
  nbfcCode: string;
  shortName: string;
  legalName: string;
  activeLoanProducts: LoanProduct[];
};

type Resp = {
  success: boolean;
  data?: { items: NbfcGroup[] };
  error?: { message: string };
};

const inr = (n: number) => `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export default function ReselectFinancingCard({
  leadId,
  assignedNbfcIds,
  slotsFree,
  onRouted,
}: {
  leadId: string;
  /** Every NBFC already on this lead, in any state — all are excluded. */
  assignedNbfcIds: number[];
  /** Section G caps a lead at 2 lenders; 0 means nothing can be added yet. */
  slotsFree: number;
  onRouted: () => void | Promise<void>;
}) {
  const [items, setItems] = useState<NbfcGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/lead/${leadId}/section-g-options`, { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (!res.ok || j.success === false) throw new Error(j.error?.message ?? `HTTP ${res.status}`);
      setItems(j.data?.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function choose(group: NbfcGroup, product: LoanProduct) {
    const ok = await confirmDialog({
      title: `Route this lead to ${group.shortName || group.legalName}?`,
      message: `${product.productName} will receive this application and can submit a firm offer. Your closed deal stays on the record.`,
      confirmText: "Send to this lender",
    });
    if (!ok) return;

    setBusy(product.id);
    setError(null);
    try {
      const res = await fetch(`/api/lead/${leadId}/reselect-financing`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nbfcId: group.nbfcId, loanProductId: product.id }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: { message?: string };
      };
      if (!res.ok || j.success === false) throw new Error(j.error?.message ?? `HTTP ${res.status}`);
      await onRouted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (items == null) return null;

  const assigned = new Set(assignedNbfcIds);
  const available = items.filter(
    (g) => !assigned.has(g.nbfcId) && g.activeLoanProducts.length > 0,
  );

  return (
    <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <h4 className="text-xs font-black uppercase tracking-wider text-slate-600">
        Choose another lender
      </h4>
      <p className="mt-1 text-xs text-slate-500">
        You deleted a loan product, which frees a lender slot on this lead. These are the other
        loan products this customer qualifies for.
      </p>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      {slotsFree <= 0 ? (
        <p className="mt-3 text-xs text-slate-500">
          This lead is already with two lenders. Delete one of those loan products to free a slot.
        </p>
      ) : available.length === 0 ? (
        <p className="mt-3 text-xs text-slate-500">
          No other lender currently matches this customer&apos;s profile. An admin can mark the
          lead as financing-unavailable, which lets you convert it to a cash sale.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          {available.flatMap((group) =>
            group.activeLoanProducts.map((product) => (
              <div
                key={`${group.nbfcId}-${product.id}`}
                className="rounded-lg border border-slate-200 bg-white p-3"
              >
                <div className="text-xs font-bold text-slate-800">{product.productName}</div>
                <div className="text-[10px] uppercase tracking-wider text-slate-400">
                  {group.shortName || group.legalName} ({group.nbfcCode})
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                  <Stat
                    k="Loan"
                    v={`${inr(product.loanAmountMin)} – ${inr(product.loanAmountMax)}`}
                  />
                  <Stat k="ROI" v={`${product.minRoiPct}% – ${product.maxRoiPct}%`} />
                  <Stat
                    k="Tenure"
                    v={`${product.tenureMonthsMin} – ${product.tenureMonthsMax} mo`}
                  />
                  <Stat k="Down pmt" v={`${product.downPaymentPct}%`} />
                </dl>
                <button
                  type="button"
                  onClick={() => choose(group, product)}
                  disabled={busy != null}
                  className="mt-2.5 w-full rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                >
                  {busy === product.id ? "Sending…" : "Select this loan product"}
                </button>
              </div>
            )),
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{k}</dt>
      <dd className="text-slate-700">{v}</dd>
    </div>
  );
}
