"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save, Plus, Ban, Pencil, X } from "lucide-react";
import { inputCls, inr, paiseToRupees, rupeesToPaise, postJson } from "./helpers";

interface Nbfc {
  id: number;
  name: string;
  nbfcCode: string;
  variant: "A" | "B";
  maxLoanCapPaise: number | null;
  flatInterestRate: string | null;
  fileFeePaise: number;
  defaultProcessingFeePaise: number;
  status: "active" | "disabled";
}
interface Scheme {
  id: number;
  code: string;
  tenureMonths: number;
  advanceMonths: number;
  appliedInterestRate: string | null;
  processingFeePaise: number | null;
  advanceInterestRate: string | null;
  status: "active" | "disabled";
}
interface Cap {
  id: number;
  modelId: number;
  maxLoanCapPaise: number;
}
interface Model {
  id: number;
  displayName: string;
}

export function NbfcDetailClient({ nbfc, schemes, caps, models }: { nbfc: Nbfc; schemes: Scheme[]; caps: Cap[]; models: Model[] }) {
  const router = useRouter();
  const [editScheme, setEditScheme] = useState<Scheme | "new" | null>(null);

  return (
    <div className="space-y-6">
      <ConstantsForm nbfc={nbfc} onSaved={() => router.refresh()} />

      {/* Schemes */}
      <div className="rounded-2xl border border-gray-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
          <h3 className="text-sm font-bold text-gray-900">Schemes</h3>
          <button onClick={() => setEditScheme("new")} className="inline-flex items-center gap-1 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-gray-800">
            <Plus className="h-3.5 w-3.5" /> Add scheme
          </button>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-gray-400">
              <th className="px-5 py-2 font-medium">Code</th>
              <th className="px-5 py-2 font-medium">Tenure</th>
              <th className="px-5 py-2 font-medium">Advance</th>
              <th className="px-5 py-2 font-medium">Rate</th>
              <th className="px-5 py-2 font-medium">Processing</th>
              <th className="px-5 py-2 font-medium">Status</th>
              <th className="px-5 py-2" />
            </tr>
          </thead>
          <tbody>
            {schemes.map((s) => (
              <tr key={s.id} className="border-t border-gray-50">
                <td className="px-5 py-3 font-semibold text-gray-900">{s.code}</td>
                <td className="px-5 py-3 text-gray-600">{s.tenureMonths}m</td>
                <td className="px-5 py-3 text-gray-600">{s.advanceMonths}</td>
                <td className="px-5 py-3 text-gray-600">{s.appliedInterestRate ?? "—"}</td>
                <td className="px-5 py-3 text-gray-600">{inr(s.processingFeePaise ?? 0)}</td>
                <td className="px-5 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${s.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>{s.status}</span>
                </td>
                <td className="px-5 py-3">
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => setEditScheme(s)} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"><Pencil className="h-3.5 w-3.5" /> Edit</button>
                    {s.status === "active" && <DeactivateBtn schemeId={s.id} onDone={() => router.refresh()} />}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Variant B per-model caps */}
      {nbfc.variant === "B" && <CapsTable nbfcId={nbfc.id} caps={caps} models={models} onSaved={() => router.refresh()} />}

      {editScheme && (
        <SchemeModal
          nbfcId={nbfc.id}
          variant={nbfc.variant}
          scheme={editScheme === "new" ? null : editScheme}
          defaultProcessingFeePaise={nbfc.defaultProcessingFeePaise}
          onClose={() => setEditScheme(null)}
          onSaved={() => { setEditScheme(null); router.refresh(); }}
        />
      )}
    </div>
  );
}

function ConstantsForm({ nbfc, onSaved }: { nbfc: Nbfc; onSaved: () => void }) {
  const [f, setF] = useState({
    name: nbfc.name,
    fileFee: String(paiseToRupees(nbfc.fileFeePaise)),
    defaultProcessing: String(paiseToRupees(nbfc.defaultProcessingFeePaise)),
    maxLoanCap: nbfc.maxLoanCapPaise != null ? String(paiseToRupees(nbfc.maxLoanCapPaise)) : "",
    flatRate: nbfc.flatInterestRate ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await postJson("/api/admin/calculator/nbfc", {
        nbfcId: nbfc.id,
        name: f.name,
        fileFeePaise: rupeesToPaise(Number(f.fileFee)),
        defaultProcessingFeePaise: rupeesToPaise(Number(f.defaultProcessing)),
        ...(nbfc.variant === "A"
          ? { maxLoanCapPaise: f.maxLoanCap ? rupeesToPaise(Number(f.maxLoanCap)) : null, flatInterestRate: f.flatRate || null }
          : {}),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-sm font-bold text-gray-900">Constants — Variant {nbfc.variant}</h3>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <L label="Name"><input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></L>
        <L label="File fee (₹, GST-incl)"><input className={inputCls} type="number" value={f.fileFee} onChange={(e) => setF({ ...f, fileFee: e.target.value })} /></L>
        <L label="Default processing (₹)"><input className={inputCls} type="number" value={f.defaultProcessing} onChange={(e) => setF({ ...f, defaultProcessing: e.target.value })} /></L>
        {nbfc.variant === "A" && (
          <>
            <L label="Flat max loan cap (₹)"><input className={inputCls} type="number" value={f.maxLoanCap} onChange={(e) => setF({ ...f, maxLoanCap: e.target.value })} /></L>
            <L label="Flat interest rate (GST-incl, e.g. 0.18)"><input className={inputCls} value={f.flatRate} onChange={(e) => setF({ ...f, flatRate: e.target.value })} /></L>
          </>
        )}
      </div>
      {nbfc.variant === "B" && (
        <p className="mt-2 text-xs text-gray-400">Variant B: cap is per-model (below) and interest rate is per-scheme.</p>
      )}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      <button onClick={save} disabled={saving} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-gray-900 px-4 py-2 text-sm font-bold text-white hover:bg-gray-800 disabled:opacity-50">
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save constants
      </button>
    </div>
  );
}

function DeactivateBtn({ schemeId, onDone }: { schemeId: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={async () => { setBusy(true); try { await postJson("/api/admin/calculator/scheme", { action: "deactivate", schemeId }); onDone(); } finally { setBusy(false); } }}
      disabled={busy}
      className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />} Disable
    </button>
  );
}

function SchemeModal({
  nbfcId, variant, scheme, defaultProcessingFeePaise, onClose, onSaved,
}: {
  nbfcId: number; variant: "A" | "B"; scheme: Scheme | null; defaultProcessingFeePaise: number; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState({
    tenure: scheme ? String(scheme.tenureMonths) : "",
    advance: scheme ? String(scheme.advanceMonths) : "0",
    rate: scheme?.appliedInterestRate ?? "",
    processing: String(paiseToRupees(scheme?.processingFeePaise ?? defaultProcessingFeePaise)),
    advanceRate: scheme?.advanceInterestRate ?? "0",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await postJson("/api/admin/calculator/scheme", {
        nbfcId,
        schemeId: scheme?.id,
        tenure: Number(f.tenure),
        advance: Number(f.advance),
        appliedInterestRate: f.rate,
        processingFeePaise: rupeesToPaise(Number(f.processing)),
        advanceInterestRate: f.advanceRate || "0",
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold text-gray-900">{scheme ? `Edit scheme ${scheme.code}` : "Add scheme"}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X className="h-5 w-5" /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <L label="Tenure (months)"><input className={inputCls} type="number" value={f.tenure} onChange={(e) => setF({ ...f, tenure: e.target.value })} /></L>
          <L label="Advance (months)"><input className={inputCls} type="number" value={f.advance} onChange={(e) => setF({ ...f, advance: e.target.value })} /></L>
          <L label="Applied rate (GST-incl)"><input className={inputCls} value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} placeholder="e.g. 0.15222" /></L>
          <L label="Processing fee (₹)"><input className={inputCls} type="number" value={f.processing} onChange={(e) => setF({ ...f, processing: e.target.value })} /></L>
          {variant === "B" && (
            <L label="Advance-interest rate"><input className={inputCls} value={f.advanceRate} onChange={(e) => setF({ ...f, advanceRate: e.target.value })} placeholder="e.g. 0.015" /></L>
          )}
        </div>
        <p className="mt-2 text-xs text-gray-400">Code is derived as <code>{f.tenure || "T"}by{f.advance || "0"}</code>. Advance must be less than tenure.</p>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-bold text-white hover:bg-gray-800 disabled:opacity-50">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </button>
        </div>
      </div>
    </div>
  );
}

function CapsTable({ nbfcId, caps, models, onSaved }: { nbfcId: number; caps: Cap[]; models: Model[]; onSaved: () => void }) {
  const capByModel = new Map(caps.map((c) => [c.modelId, c.maxLoanCapPaise]));
  return (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 px-5 py-3">
        <h3 className="text-sm font-bold text-gray-900">Per-model max-loan caps (₹)</h3>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {models.map((m) => (
            <CapRow key={m.id} nbfcId={nbfcId} model={m} capPaise={capByModel.get(m.id) ?? null} onSaved={onSaved} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CapRow({ nbfcId, model, capPaise, onSaved }: { nbfcId: number; model: Model; capPaise: number | null; onSaved: () => void }) {
  const [val, setVal] = useState(capPaise != null ? String(paiseToRupees(capPaise)) : "");
  const [busy, setBusy] = useState(false);
  const dirty = val !== (capPaise != null ? String(paiseToRupees(capPaise)) : "");
  return (
    <tr className="border-t border-gray-50">
      <td className="px-5 py-2 font-medium text-gray-800">{model.displayName}</td>
      <td className="px-5 py-2 text-right">
        <div className="flex items-center justify-end gap-2">
          <span className="text-xs text-gray-400">{capPaise != null ? inr(capPaise) : "unset"}</span>
          <input className="w-32 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-sm" type="number" value={val} onChange={(e) => setVal(e.target.value)} />
          <button
            disabled={!dirty || busy || val === ""}
            onClick={async () => { setBusy(true); try { await postJson("/api/admin/calculator/model-cap", { nbfcId, modelId: model.id, maxLoanCapPaise: rupeesToPaise(Number(val)) }); onSaved(); } finally { setBusy(false); } }}
            className="rounded-lg bg-gray-900 px-3 py-1 text-xs font-bold text-white hover:bg-gray-800 disabled:opacity-30"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
          </button>
        </div>
      </td>
    </tr>
  );
}

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      {children}
    </label>
  );
}
