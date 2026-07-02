"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, X, Globe } from "lucide-react";
import { inputCls, postJson } from "./helpers";

interface City {
  id: number;
  display: string | null;
  normalized: string | null;
  stateCode: string | null;
}
interface CoverageGroup {
  nbfcId: number;
  nbfcName: string;
  variant: "A" | "B";
  panIndia: boolean;
  cities: City[];
}

export function EligibilityClient({ groups }: { groups: CoverageGroup[] }) {
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <NbfcCoverage key={g.nbfcId} group={g} />
      ))}
    </div>
  );
}

function NbfcCoverage({ group }: { group: CoverageGroup }) {
  const router = useRouter();
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!city.trim() || !state.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/admin/calculator/coverage", { nbfcId: group.nbfcId, cityDisplay: city.trim(), stateCode: state.trim() });
      setCity("");
      setState("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    await postJson("/api/admin/calculator/coverage", { action: "remove", coverageId: id });
    router.refresh();
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-900">{group.nbfcName}</h3>
        {group.panIndia && (
          <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-700">
            <Globe className="h-3.5 w-3.5" /> Pan-India
          </span>
        )}
      </div>

      {group.panIndia ? (
        <p className="text-xs text-gray-500">Serves every resolved location. No city list needed.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {group.cities.length === 0 && <span className="text-xs text-gray-400">No cities yet.</span>}
            {group.cities.map((c) => (
              <span key={c.id} className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
                {c.display}
                {c.stateCode ? `, ${c.stateCode}` : ""}
                <button onClick={() => remove(c.id)} className="text-gray-400 hover:text-red-600"><X className="h-3 w-3" /></button>
              </span>
            ))}
          </div>

          <div className="mt-4 flex items-end gap-2">
            <label className="block">
              <span className="mb-1 block text-xs text-gray-500">City</span>
              <input className={inputCls} value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Kanpur" />
            </label>
            <label className="block w-24">
              <span className="mb-1 block text-xs text-gray-500">State</span>
              <input className={inputCls} value={state} onChange={(e) => setState(e.target.value)} placeholder="UP" maxLength={3} />
            </label>
            <button onClick={add} disabled={busy} className="inline-flex items-center gap-1 rounded-lg bg-gray-900 px-3 py-2 text-sm font-bold text-white hover:bg-gray-800 disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </>
      )}
    </div>
  );
}
