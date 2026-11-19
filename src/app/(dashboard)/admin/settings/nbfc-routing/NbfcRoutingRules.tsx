"use client";

// E-391 — NBFC routing rules: list, add, deactivate, and test a lead.
// API: /api/admin/settings/nbfc-routing

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { useIndiaLocationData } from "@/lib/location/useIndiaLocationData";

type Rule = {
  id: number;
  scope: string;
  weight: number;
  nbfcName: string | null;
  productName: string | null;
  is_active: boolean;
  notes: string | null;
  createdBy: string | null;
  created_at: string;
};
type NbfcOpt = { id: number; name: string; products: Array<{ id: number; name: string; loanAmountMax: number }> };
type TestResult = { ok: true; ruleId: number; scope: string; nbfcName: string; productName: string } | { ok: false; why: string; ruleId: number | null };

export default function NbfcRoutingRules() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [nbfcs, setNbfcs] = useState<NbfcOpt[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/settings/nbfc-routing", { cache: "no-store" });
      const j = await res.json();
      if (!j.success) throw new Error(j.error?.message || "Could not load the rules");
      setRules(j.data.rules);
      setCategories(j.data.categories);
      setNbfcs(j.data.nbfcs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the rules");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function deactivate(id: number) {
    if (!confirm(`Deactivate rule #${id}? New files will no longer be sent by it.`)) return;
    const res = await fetch(`/api/admin/settings/nbfc-routing?id=${id}`, { method: "DELETE" });
    const j = await res.json().catch(() => null);
    if (!j?.success) toast.error(j?.error?.message || "Could not deactivate");
    else {
      toast.success("Rule deactivated");
      await load();
    }
  }

  return (
    <div className="space-y-5">
      <AddRule categories={categories} nbfcs={nbfcs} onSaved={load} />
      <TestLead />
      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {rules && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">#</th>
                <th className="px-4 py-2">When the lead is</th>
                <th className="px-4 py-2">Send to</th>
                <th className="px-4 py-2" title="Higher wins when several rules fit">Specific</th>
                <th className="px-4 py-2">Added</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-gray-500">
                    No routing rules yet — every file gets the usual lender choice.
                  </td>
                </tr>
              )}
              {rules.map((r) => (
                <tr key={r.id} className={`border-t border-gray-100 ${r.is_active ? "" : "opacity-50"}`}>
                  <td className="px-4 py-2 tabular-nums">{r.id}</td>
                  <td className="px-4 py-2">
                    {r.scope}
                    {r.notes && <span className="block text-xs text-gray-500">{r.notes}</span>}
                  </td>
                  <td className="px-4 py-2">
                    <b>{r.nbfcName ?? "—"}</b>
                    <span className="block text-xs text-gray-500">{r.productName ?? "—"}</span>
                  </td>
                  <td className="px-4 py-2 tabular-nums">{r.weight}</td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {new Date(r.created_at).toLocaleDateString("en-IN")}
                    {r.createdBy ? ` · ${r.createdBy}` : ""}
                  </td>
                  <td className="px-4 py-2">{r.is_active ? "Active" : "Off"}</td>
                  <td className="px-4 py-2 text-right">
                    {r.is_active && (
                      <button type="button" className="text-xs font-medium text-red-700" onClick={() => void deactivate(r.id)}>
                        Deactivate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AddRule({ categories, nbfcs, onSaved }: { categories: string[]; nbfcs: NbfcOpt[]; onSaved: () => void }) {
  const loc = useIndiaLocationData();
  const [dealerQ, setDealerQ] = useState("");
  const [dealerResults, setDealerResults] = useState<Array<{ dealerId: string; name: string }>>([]);
  const [dealer, setDealer] = useState<{ dealerId: string; name: string } | null>(null);
  const [stateIso, setStateIso] = useState("");
  const [city, setCity] = useState("");
  const [category, setCategory] = useState("");
  const [nbfcId, setNbfcId] = useState<number | "">("");
  const [productId, setProductId] = useState<number | "">("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const stateName = useMemo(() => loc.states.find((s) => s.isoCode === stateIso)?.name ?? "", [loc.states, stateIso]);
  const cities = useMemo(() => (stateIso ? loc.getCitiesOfState(stateIso) : []), [loc, stateIso]);
  const products = nbfcs.find((n) => n.id === nbfcId)?.products ?? [];

  useEffect(() => {
    if (dealer) return;
    const q = dealerQ.trim();
    if (q.length < 2) {
      setDealerResults([]);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      const r = await fetch(`/api/leads/dealer-lookup?q=${encodeURIComponent(q)}`, { cache: "no-store" });
      const j = await r.json().catch(() => null);
      if (alive) setDealerResults(j?.success ? j.data?.dealers ?? [] : []);
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [dealerQ, dealer]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!nbfcId || !productId) return toast.error("Pick the NBFC and loan product.");
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings/nbfc-routing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dealer_code: dealer?.dealerId ?? null,
          state: stateName || null,
          city: city || null,
          product_category: category || null,
          nbfc_id: nbfcId,
          loan_product_id: productId,
          notes: notes || null,
        }),
      });
      const j = await res.json().catch(() => null);
      if (!j?.success) throw new Error(j?.error?.message || "Could not save the rule");
      toast.success(`Rule #${j.data.id} added`);
      setDealer(null);
      setDealerQ("");
      setStateIso("");
      setCity("");
      setCategory("");
      setNbfcId("");
      setProductId("");
      setNotes("");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the rule");
    } finally {
      setSaving(false);
    }
  }

  const sel = "w-full rounded border border-gray-300 px-3 py-2 text-sm bg-white";
  return (
    <form onSubmit={save} className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
      <div className="text-sm font-semibold text-gray-900">Add a rule</div>
      <p className="text-xs text-gray-500">Leave a field blank to match any. Set at least one of dealer, state, city or category.</p>
      <div className="grid gap-3 md:grid-cols-4">
        <div className="md:col-span-2">
          <label className="block text-xs font-semibold text-gray-600 mb-1">Dealer</label>
          {dealer ? (
            <div className="flex items-center justify-between rounded border border-green-200 bg-green-50 px-3 py-2 text-sm">
              <span className="truncate font-semibold text-green-800">{dealer.name}</span>
              <button type="button" className="text-xs text-gray-600" onClick={() => setDealer(null)}>
                Change
              </button>
            </div>
          ) : (
            <>
              <input value={dealerQ} onChange={(e) => setDealerQ(e.target.value)} placeholder="Any dealer — or search name / mobile" className={sel} />
              {dealerResults.length > 0 && (
                <ul className="mt-1 max-h-40 overflow-y-auto rounded border border-gray-200 divide-y divide-gray-100">
                  {dealerResults.map((d) => (
                    <li key={d.dealerId}>
                      <button type="button" className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-50" onClick={() => { setDealer(d); setDealerResults([]); }}>
                        {d.name} <span className="text-xs text-gray-500">{d.dealerId}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Customer state</label>
          <select className={sel} value={stateIso} disabled={!loc.loaded} onChange={(e) => { setStateIso(e.target.value); setCity(""); }}>
            <option value="">Any state</option>
            {loc.states.map((s) => (
              <option key={s.isoCode} value={s.isoCode}>{s.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Customer city</label>
          <select className={sel} value={city} disabled={!stateIso} onChange={(e) => setCity(e.target.value)}>
            <option value="">Any city</option>
            {cities.map((c) => (
              <option key={`${c.name}-${c.latitude}`} value={c.name}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Product category</label>
          <select className={sel} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Any category</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Send to NBFC *</label>
          <select className={sel} value={nbfcId} onChange={(e) => { setNbfcId(e.target.value ? Number(e.target.value) : ""); setProductId(""); }}>
            <option value="">Pick NBFC</option>
            {nbfcs.map((n) => (
              <option key={n.id} value={n.id}>{n.name}</option>
            ))}
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs font-semibold text-gray-600 mb-1">Loan product *</label>
          <select className={sel} value={productId} disabled={!nbfcId} onChange={(e) => setProductId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Pick product</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.name} (up to ₹{Number(p.loanAmountMax).toLocaleString("en-IN")})</option>
            ))}
          </select>
        </div>
        <div className="md:col-span-4">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Note (optional)" maxLength={500} className={sel} />
        </div>
      </div>
      <button type="submit" disabled={saving} className="rounded-lg bg-[#0047AB] px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
        {saving ? "Saving…" : "Add rule"}
      </button>
    </form>
  );
}

function TestLead() {
  const [leadId, setLeadId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  async function test(e: React.FormEvent) {
    e.preventDefault();
    if (!leadId.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/admin/settings/nbfc-routing?leadId=${encodeURIComponent(leadId.trim())}`, { cache: "no-store" });
      const j = await res.json();
      if (!j.success) throw new Error(j.error?.message || "Test failed");
      setResult(j.data.test);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={test} className="rounded-lg border border-gray-200 bg-white p-4 space-y-2">
      <div className="text-sm font-semibold text-gray-900">Test a lead</div>
      <div className="flex gap-2">
        <input value={leadId} onChange={(e) => setLeadId(e.target.value)} placeholder="Lead ID, e.g. LEAD-20261119-883db412" className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm" />
        <button type="submit" disabled={busy} className="rounded border border-gray-300 px-4 py-2 text-sm font-medium disabled:opacity-60">
          {busy ? "Checking…" : "Check"}
        </button>
      </div>
      {result &&
        (result.ok ? (
          <p className="text-sm text-emerald-700">
            Rule #{result.ruleId} ({result.scope}) → <b>{result.nbfcName}</b> · {result.productName}. This lead would be sent there automatically.
          </p>
        ) : (
          <p className="text-sm text-amber-800">{result.why}. The dealer would get the usual lender choice.</p>
        ))}
    </form>
  );
}
