"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, X } from "lucide-react";
import { inputCls, inr, paiseToRupees, rupeesToPaise, postJson } from "./helpers";

type Comp = "battery" | "charger" | "harness" | "soc" | "iot";
const COMPONENTS: Comp[] = ["battery", "charger", "harness", "soc", "iot"];

interface ModelRow {
  id: number;
  skuCode: string;
  displayName: string;
  components: Record<string, { amountPaise: number; gstMultiplier: string }>;
}

export function PricesClient({ models }: { models: ModelRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<ModelRow | null>(null);

  return (
    <>
      <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-gray-400">
              <th className="px-4 py-2 font-medium">Model</th>
              {COMPONENTS.map((c) => (
                <th key={c} className="px-4 py-2 font-medium capitalize">{c}</th>
              ))}
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id} className="border-t border-gray-50">
                <td className="px-4 py-3">
                  <p className="font-semibold text-gray-900">{m.displayName}</p>
                  <p className="text-xs text-gray-400">{m.skuCode}</p>
                </td>
                {COMPONENTS.map((c) => (
                  <td key={c} className="px-4 py-3 text-gray-700">
                    {m.components[c] ? inr(m.components[c].amountPaise) : "—"}
                  </td>
                ))}
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => setEditing(m)}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && <EditModal model={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); router.refresh(); }} />}
    </>
  );
}

function EditModal({ model, onClose, onSaved }: { model: ModelRow; onClose: () => void; onSaved: () => void }) {
  const original: Record<Comp, { rupees: string; gst: string }> = {} as never;
  for (const c of COMPONENTS) {
    original[c] = {
      rupees: String(paiseToRupees(model.components[c]?.amountPaise ?? 0)),
      gst: model.components[c]?.gstMultiplier ?? (c === "charger" ? "1.05" : "1.18"),
    };
  }
  const [draft, setDraft] = useState(original);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changes = COMPONENTS.filter(
    (c) => draft[c].rupees !== original[c].rupees || draft[c].gst !== original[c].gst,
  );

  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      for (const c of changes) {
        await postJson("/api/admin/calculator/component-price", {
          modelId: model.id,
          component: c,
          amountPaise: rupeesToPaise(Number(draft[c].rupees)),
          gstMultiplier: draft[c].gst,
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold text-gray-900">{model.displayName} — component prices</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X className="h-5 w-5" /></button>
        </div>

        {!confirming ? (
          <>
            <div className="space-y-3">
              {COMPONENTS.map((c) => (
                <div key={c} className="grid grid-cols-[1fr_1fr_90px] items-end gap-3">
                  <span className="pb-2 text-sm font-medium capitalize text-gray-700">{c}</span>
                  <label className="block">
                    <span className="mb-1 block text-xs text-gray-500">Amount (₹)</span>
                    <input className={inputCls} type="number" value={draft[c].rupees}
                      onChange={(e) => setDraft((d) => ({ ...d, [c]: { ...d[c], rupees: e.target.value } }))} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-gray-500">GST ×</span>
                    <input className={inputCls} value={draft[c].gst}
                      onChange={(e) => setDraft((d) => ({ ...d, [c]: { ...d[c], gst: e.target.value } }))} />
                  </label>
                </div>
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
              <button
                onClick={() => setConfirming(true)}
                disabled={changes.length === 0}
                className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-bold text-white hover:bg-gray-800 disabled:opacity-40"
              >
                Review {changes.length} change{changes.length === 1 ? "" : "s"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mb-3 text-sm text-gray-600">
              Confirm — this changes EMI, down payment and file charge for <b>{model.displayName}</b> across all NBFCs immediately.
            </p>
            <ul className="space-y-2 rounded-xl bg-gray-50 p-3 text-sm">
              {changes.map((c) => (
                <li key={c} className="flex items-center justify-between">
                  <span className="capitalize text-gray-700">{c}</span>
                  <span className="text-gray-500">
                    {inr(rupeesToPaise(Number(original[c].rupees)))} (×{original[c].gst}) →{" "}
                    <b className="text-gray-900">{inr(rupeesToPaise(Number(draft[c].rupees)))}</b> (×{draft[c].gst})
                  </span>
                </li>
              ))}
            </ul>
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirming(false)} disabled={saving} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">Back</button>
              <button onClick={confirm} disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-50">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} Confirm & publish
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
