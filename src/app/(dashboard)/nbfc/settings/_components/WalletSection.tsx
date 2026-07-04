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
  // iTarang Virtual Account (funds-in routing) + auto-recharge mandate (§16.4).
  va_upi_vpa: string | null;
  va_account_number: string | null;
  va_ifsc: string | null;
  va_status: string | null;
  auto_nach_status: string | null;
  auto_nach_token_id: string | null;
};

type RzpCheckout = {
  order_id: string;
  key_id: string;
  customer_id: string;
  amount: number;
  currency?: string;
};

// Lazily inject Razorpay Checkout.js — same head-injection pattern the E-NACH
// panel uses (the VPS can't bundle third-party scripts). Vendor name stays out
// of the NBFC-facing copy (§3.2); only this loader URL references it.
function loadRazorpayCheckout(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve(false);
    const w = window as unknown as { Razorpay?: unknown };
    if (w.Razorpay) return resolve(true);
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://checkout.razorpay.com/v1/checkout.js"]',
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(true));
      existing.addEventListener("error", () => resolve(false));
      return;
    }
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}
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
      setError(null); // a good load clears any stale error from a prior failed action
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

  // Issue (or refresh) the iTarang Virtual Account the NBFC pays top-ups into.
  async function issueVirtualAccount() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/nbfc/settings/wallet/virtual-account", { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Register / re-register the iTarang Auto-Recharge Mandate. Opens the
  // authorisation popup; on success the signed result is server-verified.
  async function registerAutoRecharge() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/nbfc/settings/wallet/auto-recharge/register", { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        handoff?: { checkout?: RzpCheckout };
      };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      const checkout = j.handoff?.checkout;
      if (!checkout) throw new Error("No authorisation handoff returned.");
      const ok = await loadRazorpayCheckout();
      if (!ok) throw new Error("Could not load the authorisation popup. Check your connection and retry.");
      const w = window as unknown as { Razorpay: new (opts: Record<string, unknown>) => { open: () => void } };
      const rzp = new w.Razorpay({
        key: checkout.key_id,
        order_id: checkout.order_id,
        customer_id: checkout.customer_id,
        recurring: 1,
        name: "iTarang",
        description: "iTarang Auto-Recharge Mandate",
        handler: (resp: {
          razorpay_payment_id?: string;
          razorpay_order_id?: string;
          razorpay_signature?: string;
        }) => {
          void confirmAutoRecharge(resp);
        },
        modal: { ondismiss: () => void load() },
      });
      rzp.open();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Server-verified confirmation of the mandate authorisation (localhost path;
  // the inflow webhook is the async source of truth in production).
  async function confirmAutoRecharge(resp: {
    razorpay_payment_id?: string;
    razorpay_order_id?: string;
    razorpay_signature?: string;
  }) {
    if (!resp?.razorpay_payment_id || !resp?.razorpay_order_id || !resp?.razorpay_signature) {
      setError("Authorisation returned no signed result to confirm.");
      await load();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/nbfc/settings/wallet/auto-recharge/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(resp),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await load();
    }
  }

  const mandateStatus = wallet?.auto_nach_status ?? "none";
  const mandateBadge: Record<string, string> = {
    registered: "bg-emerald-100 text-emerald-700",
    pending: "bg-amber-100 text-amber-700",
    failed: "bg-red-100 text-red-700",
    none: "bg-slate-100 text-slate-500",
  };

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

      {/* iTarang Virtual Account — funds-in (display-only, §15.3) */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">iTarang Virtual Account</h3>
          {canEdit && (
            <button
              onClick={issueVirtualAccount}
              disabled={busy}
              className="px-3 py-1.5 rounded-md border border-slate-300 text-xs font-semibold text-slate-700 disabled:opacity-50"
            >
              {wallet?.va_upi_vpa || wallet?.va_account_number ? "Refresh" : "Issue"}
            </button>
          )}
        </div>
        {wallet?.va_upi_vpa || wallet?.va_account_number ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">UPI ID</dt>
              <dd className="tabular-nums text-slate-700 dark:text-slate-200">{wallet?.va_upi_vpa ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Account number</dt>
              <dd className="tabular-nums text-slate-700 dark:text-slate-200">{wallet?.va_account_number ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">IFSC</dt>
              <dd className="tabular-nums text-slate-700 dark:text-slate-200">{wallet?.va_ifsc ?? "—"}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-slate-500 italic">
            No virtual account issued yet. Issue one to fund the wallet via UPI/NEFT — top-ups are auto-credited within seconds.
          </p>
        )}
      </div>

      {/* iTarang Auto-Recharge Mandate — funds-in (creditor-side NACH, §16.4) */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">iTarang Auto-Recharge Mandate</h3>
          <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded ${mandateBadge[mandateStatus] ?? mandateBadge.none}`}>
            {mandateStatus === "none" ? "not set up" : mandateStatus}
          </span>
        </div>
        <p className="text-xs text-slate-500">
          Authorises iTarang to auto-recharge this wallet when the balance falls below your threshold.
        </p>
        {canEdit && (
          <button
            onClick={registerAutoRecharge}
            disabled={busy}
            className="px-3 py-1.5 rounded-md bg-[color:var(--color-brand-navy)] text-white text-xs font-semibold disabled:opacity-50"
          >
            {mandateStatus === "registered" ? "Re-register mandate" : "Register mandate"}
          </button>
        )}
      </div>

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
