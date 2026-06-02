"use client";

/**
 * Wallet block — Addendum V0.2 §8.1. Prepaid balance, transaction history, and
 * auto-NACH recharge config (the NBFC sets the trigger threshold + recharge
 * amount). Top-ups are posted by iTarang admin / auto-NACH; this view is
 * balance + history + auto-NACH config.
 */
import { useCallback, useEffect, useState } from "react";

type Wallet = {
  balance: string;
  currency: string;
  auto_nach_enabled: boolean;
  auto_nach_threshold: string | null;
  auto_nach_recharge_amount: string | null;
};
type Ledger = {
  id: string;
  kind: string;
  type: string | null;
  description: string;
  amount: string;
  balance_after: string;
  created_at: string;
};

function inr(v: string | number | null | undefined): string {
  if (v == null) return "—";
  const n = Number(v);
  return Number.isFinite(n) ? `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : "—";
}

export default function WalletSection({ canEdit }: { canEdit: boolean }) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [threshold, setThreshold] = useState("");
  const [recharge, setRecharge] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/nbfc/settings/wallet");
      const j = (await res.json()) as { ok: boolean; wallet?: Wallet; ledger?: Ledger[]; error?: string };
      if (!j.ok) throw new Error(j.error ?? "Failed to load wallet");
      setWallet(j.wallet ?? null);
      setLedger(j.ledger ?? []);
      setEnabled(j.wallet?.auto_nach_enabled ?? false);
      setThreshold(j.wallet?.auto_nach_threshold ?? "");
      setRecharge(j.wallet?.auto_nach_recharge_amount ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (enabled && (!threshold.trim() || !recharge.trim())) {
      setError("Set both the threshold and the recharge amount to enable auto-NACH.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/nbfc/settings/wallet", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          auto_nach_enabled: enabled,
          auto_nach_threshold: enabled ? Number(threshold) : null,
          auto_nach_recharge_amount: enabled ? Number(recharge) : null,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      setSavedAt(new Date());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500">Wallet</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Prepaid balance. Service charges are deducted per the iTarang billing configuration (§8).
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Balance</p>
          <p className="text-2xl font-bold text-[color:var(--color-brand-navy)]">{inr(wallet?.balance)}</p>
        </div>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {/* Auto-NACH config */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-3">
        <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <input type="checkbox" checked={enabled} disabled={!canEdit} onChange={(e) => setEnabled(e.target.checked)} />
          Auto-NACH recharge
        </label>
        {enabled && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Trigger threshold (₹)</label>
              <input
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                disabled={!canEdit}
                inputMode="numeric"
                className="w-full mt-1 text-sm border border-slate-200 rounded-md px-2 py-1.5"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Recharge amount (₹)</label>
              <input
                value={recharge}
                onChange={(e) => setRecharge(e.target.value)}
                disabled={!canEdit}
                inputMode="numeric"
                className="w-full mt-1 text-sm border border-slate-200 rounded-md px-2 py-1.5"
              />
            </div>
          </div>
        )}
        {canEdit && (
          <div className="flex items-center gap-3">
            <button onClick={save} disabled={busy} className="px-3 py-1.5 rounded-md bg-[color:var(--color-brand-navy)] text-white text-xs font-semibold disabled:opacity-50">
              Save auto-NACH
            </button>
            {savedAt && <span className="text-[11px] text-emerald-600">Saved.</span>}
          </div>
        )}
      </div>

      {/* Transaction history */}
      <div>
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Transaction history</h3>
        {ledger.length === 0 ? (
          <p className="text-sm text-slate-500 italic">No transactions yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/50 text-[10px] uppercase tracking-widest text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-bold">Date</th>
                <th className="px-3 py-2 text-left font-bold">Description</th>
                <th className="px-3 py-2 text-right font-bold">Amount</th>
                <th className="px-3 py-2 text-right font-bold">Balance</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((l) => {
                const amt = Number(l.amount);
                return (
                  <tr key={l.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-3 py-1.5 text-xs text-slate-500 tabular-nums">{new Date(l.created_at).toLocaleDateString("en-IN")}</td>
                    <td className="px-3 py-1.5">{l.description}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums font-semibold ${amt < 0 ? "text-red-600" : "text-emerald-600"}`}>
                      {amt < 0 ? "−" : "+"}
                      {inr(Math.abs(amt))}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{inr(l.balance_after)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
