"use client";

/**
 * Admin NBFC Billing — BRD Addendum V0.2 §8.2. The iTarang admin maintains the
 * chargeable-item catalogue, posts manual top-ups / one-off deductions, and
 * views the monthly GST (usage) statement. The NBFC is the billing party.
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";

type Item = {
  id: string;
  tenant_id: string | null;
  name: string;
  
  type: string;
  amount: string;
  trigger: string;
  status: string;
};
type Wallet = { balance: string; currency: string };
type Ledger = { id: string; kind: string; description: string; amount: string; balance_after: string; month: string; created_at: string };

const TYPES = ["service_usage", "platform_fee", "disbursal_fee", "other"];
const TRIGGERS = ["on_api_execution", "on_vkyc_run", "on_disbursal", "monthly", "manual"];

function inr(v: string | number | null | undefined): string {
  if (v == null) return "—";
  const n = Number(v);
  return Number.isFinite(n) ? `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : "—";
}

export default function AdminNbfcBillingPage() {
  const params = useParams<{ nbfcId: string }>();
  const nbfcId = params.nbfcId;

  const [items, setItems] = useState<Item[]>([]);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // New catalogue item form
  const [form, setForm] = useState({ name: "", type: "service_usage", amount: "", trigger: "on_vkyc_run", global: false });
  // Wallet ops
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  // Statement
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [statement, setStatement] = useState<{ totals: { debits: number; credits: number; by_type: Record<string, number> }; lines: Ledger[] } | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, w] = await Promise.all([
        fetch(`/api/admin/nbfc/${nbfcId}/charges`).then((r) => r.json()),
        fetch(`/api/admin/nbfc/${nbfcId}/wallet`).then((r) => r.json()),
      ]);
      if (c.ok) setItems(c.items);
      if (w.ok) {
        setWallet(w.wallet);
        setLedger(w.ledger);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [nbfcId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function call(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/nbfc/${nbfcId}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addItem() {
    if (!form.name.trim() || !form.amount.trim()) return;
    const ok = await call("/charges", "POST", { ...form, amount: Number(form.amount) });
    if (ok) setForm({ name: "", type: "service_usage", amount: "", trigger: "on_vkyc_run", global: false });
  }

  async function loadStatement() {
    setError(null);
    try {
      const res = await fetch(`/api/admin/nbfc/${nbfcId}/gst-statement?month=${month}`);
      const j = await res.json();
      if (!j.ok) throw new Error(j.error ?? "Failed");
      setStatement({ totals: j.totals, lines: j.lines });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="px-6 py-8 space-y-6 max-w-5xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">NBFC · Billing</p>
          <h1 className="text-2xl font-semibold text-[color:var(--color-brand-navy)] mt-1">Wallet &amp; Charging</h1>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Balance</p>
          <p className="text-2xl font-bold text-[color:var(--color-brand-navy)]">{inr(wallet?.balance)}</p>
        </div>
      </header>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* Chargeable-item catalogue */}
      <section className="border border-slate-200 rounded-xl bg-white p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">Chargeable-item catalogue</h2>
        <table className="w-full text-sm">
          <thead className="text-[10px] uppercase tracking-widest text-slate-500 bg-slate-50">
            <tr>
              <th className="px-2 py-2 text-left">Name</th>
              <th className="px-2 py-2 text-left">Type</th>
              <th className="px-2 py-2 text-left">Trigger</th>
              <th className="px-2 py-2 text-right">Amount</th>
              <th className="px-2 py-2 text-left">Scope</th>
              <th className="px-2 py-2 text-left">Status</th>
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id} className="border-t border-slate-100">
                <td className="px-2 py-1.5 font-medium">{it.name}</td>
                <td className="px-2 py-1.5 text-xs">{it.type.replace(/_/g, " ")}</td>
                <td className="px-2 py-1.5 text-xs font-mono">{it.trigger}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{inr(it.amount)}</td>
                <td className="px-2 py-1.5 text-xs">{it.tenant_id ? "This NBFC" : "Global"}</td>
                <td className="px-2 py-1.5">
                  <button
                    onClick={() => call(`/charges/${it.id}`, "PUT", { status: it.status === "active" ? "inactive" : "active" })}
                    disabled={busy}
                    className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${it.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"}`}
                  >
                    {it.status}
                  </button>
                </td>
                <td className="px-2 py-1.5 text-right">
                  <button onClick={() => call(`/charges/${it.id}`, "DELETE")} disabled={busy} className="text-xs text-red-600">
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Add item */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end pt-2 border-t border-slate-100">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Item name" className="text-sm border border-slate-200 rounded-md px-2 py-1.5 col-span-2" />
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="text-sm border border-slate-200 rounded-md px-2 py-1.5">
            {TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
          </select>
          <select value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value })} className="text-sm border border-slate-200 rounded-md px-2 py-1.5">
            {TRIGGERS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="Amount" inputMode="numeric" className="text-sm border border-slate-200 rounded-md px-2 py-1.5" />
          <button onClick={addItem} disabled={busy} className="px-3 py-1.5 rounded-md bg-[color:var(--color-brand-navy)] text-white text-xs font-semibold disabled:opacity-50">Add</button>
          <label className="col-span-2 flex items-center gap-1.5 text-xs text-slate-500">
            <input type="checkbox" checked={form.global} onChange={(e) => setForm({ ...form, global: e.target.checked })} /> Global default (all NBFCs)
          </label>
        </div>
      </section>

      {/* Wallet ops */}
      <section className="border border-slate-200 rounded-xl bg-white p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">Top-up / Manual deduction</h2>
        <div className="flex flex-wrap gap-2 items-end">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount (₹)" inputMode="numeric" className="text-sm border border-slate-200 rounded-md px-2 py-1.5 w-32" />
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description / reason" className="text-sm border border-slate-200 rounded-md px-2 py-1.5 flex-1 min-w-[200px]" />
          <button
            onClick={() => amount && desc && call("/wallet", "POST", { action: "topup", amount: Number(amount), description: desc }).then((ok) => ok && (setAmount(""), setDesc("")))}
            disabled={busy}
            className="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-semibold disabled:opacity-50"
          >
            Top-up
          </button>
          <button
            onClick={() => amount && desc && call("/wallet", "POST", { action: "manual_deduction", amount: Number(amount), description: desc }).then((ok) => ok && (setAmount(""), setDesc("")))}
            disabled={busy}
            className="px-3 py-1.5 rounded-md bg-red-600 text-white text-xs font-semibold disabled:opacity-50"
          >
            Deduct
          </button>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {ledger.slice(0, 15).map((l) => {
              const amt = Number(l.amount);
              return (
                <tr key={l.id} className="border-t border-slate-100">
                  <td className="px-2 py-1.5 text-xs text-slate-500">{new Date(l.created_at).toLocaleDateString("en-IN")}</td>
                  <td className="px-2 py-1.5">{l.description}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${amt < 0 ? "text-red-600" : "text-emerald-600"}`}>{amt < 0 ? "−" : "+"}{inr(Math.abs(amt))}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">{inr(l.balance_after)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* GST statement */}
      <section className="border border-slate-200 rounded-xl bg-white p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">Monthly GST (usage) statement</h2>
          <div className="flex gap-2">
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="text-sm border border-slate-200 rounded-md px-2 py-1" />
            <button onClick={loadStatement} className="px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 text-xs font-semibold">Generate</button>
          </div>
        </div>
        {statement && (
          <div className="space-y-2">
            <div className="flex gap-6 text-sm">
              <span>Total debits: <b className="text-red-600">{inr(statement.totals.debits)}</b></span>
              <span>Total credits: <b className="text-emerald-600">{inr(statement.totals.credits)}</b></span>
            </div>
            <div className="flex gap-3 flex-wrap text-xs text-slate-600">
              {Object.entries(statement.totals.by_type).map(([k, v]) => (
                <span key={k} className="px-2 py-1 rounded bg-slate-100">{k.replace(/_/g, " ")}: {inr(v)}</span>
              ))}
            </div>
            <p className="text-[11px] text-slate-400">{statement.lines.length} line item(s). This is a usage statement — the wallet is prepaid.</p>
          </div>
        )}
      </section>
    </div>
  );
}
