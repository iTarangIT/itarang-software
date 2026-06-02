"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  NBFC_OWNER_STEPS,
  NBFC_STEP_LABELS,
  type NbfcOwnerStep,
} from "@/lib/nbfc/origination-roles";

// BRD Addendum V0.2 §7.2 — per-NBFC step ownership. A default owner per step
// (no city) plus optional city-wise overrides. The owner is notified +
// accountable; any user holding the role may still act so work doesn't stall.

interface Member {
  user_id: string;
  email: string | null;
  name: string | null;
}

interface OwnerRow {
  step: NbfcOwnerStep;
  city: string | null;
  user_id: string;
}

interface Props {
  members: Member[];
  initialOwners: OwnerRow[];
  canEdit: boolean;
}

let rowKey = 0;

export default function StepOwnersSection({ members, initialOwners, canEdit }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<(OwnerRow & { _k: number })[]>(() =>
    initialOwners.map((o) => ({ ...o, _k: rowKey++ })),
  );
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  function memberName(userId: string): string {
    const m = members.find((x) => x.user_id === userId);
    return m?.name ?? m?.email ?? userId;
  }

  function addRow() {
    setRows((r) => [
      ...r,
      { step: "fi", city: null, user_id: members[0]?.user_id ?? "", _k: rowKey++ },
    ]);
    setSavedAt(null);
  }

  function update(k: number, patch: Partial<OwnerRow>) {
    setRows((r) => r.map((row) => (row._k === k ? { ...row, ...patch } : row)));
    setSavedAt(null);
  }

  function removeRow(k: number) {
    setRows((r) => r.filter((row) => row._k !== k));
    setSavedAt(null);
  }

  async function save() {
    // Catch duplicate (step, city) before the server / DB unique index does.
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.user_id) {
        setError("Every owner row needs a user.");
        return;
      }
      const key = `${r.step}::${(r.city ?? "").trim().toLowerCase()}`;
      if (seen.has(key)) {
        setError(
          `Duplicate owner for ${NBFC_STEP_LABELS[r.step]}${r.city ? ` / ${r.city}` : " (default)"}.`,
        );
        return;
      }
      seen.add(key);
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/nbfc/settings/step-owners", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owners: rows.map((r) => ({
            step: r.step,
            city: r.city && r.city.trim() ? r.city.trim() : null,
            user_id: r.user_id,
          })),
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setSavedAt(new Date());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
      <div>
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500">Step owners</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Who is notified and accountable per step. Leave the city blank for the default owner; add a
          city to override it for that location. Any user with the role may still act.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500 italic">No step owners configured.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs uppercase tracking-widest text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-bold">Step</th>
              <th className="px-3 py-2 text-left font-bold">City (blank = default)</th>
              <th className="px-3 py-2 text-left font-bold">Owner</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r._k} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-3 py-2">
                  <select
                    value={r.step}
                    disabled={!canEdit || busy}
                    onChange={(e) => update(r._k, { step: e.target.value as NbfcOwnerStep })}
                    className="border border-slate-300 rounded px-2 py-1 text-sm"
                  >
                    {NBFC_OWNER_STEPS.map((s) => (
                      <option key={s} value={s}>
                        {NBFC_STEP_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    value={r.city ?? ""}
                    placeholder="(default)"
                    disabled={!canEdit || busy}
                    onChange={(e) => update(r._k, { city: e.target.value || null })}
                    className="border border-slate-300 rounded px-2 py-1 text-sm w-40"
                  />
                </td>
                <td className="px-3 py-2">
                  {canEdit ? (
                    <select
                      value={r.user_id}
                      disabled={busy}
                      onChange={(e) => update(r._k, { user_id: e.target.value })}
                      className="border border-slate-300 rounded px-2 py-1 text-sm"
                    >
                      {members.map((m) => (
                        <option key={m.user_id} value={m.user_id}>
                          {m.name ?? m.email ?? m.user_id}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span>{memberName(r.user_id)}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  {canEdit ? (
                    <button
                      onClick={() => removeRow(r._k)}
                      disabled={busy}
                      className="text-xs text-red-600 hover:underline disabled:opacity-50"
                    >
                      Remove
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error ? (
        <div className="px-3 py-2 bg-red-50 text-red-700 text-xs rounded">{error}</div>
      ) : null}

      {canEdit ? (
        <div className="flex justify-between items-center gap-3">
          <button
            onClick={addRow}
            disabled={busy || members.length === 0}
            className="text-xs font-bold text-[color:var(--color-brand-navy)] hover:underline disabled:opacity-50"
          >
            + Add owner
          </button>
          <div className="flex items-center gap-3">
            {savedAt ? (
              <span className="text-xs text-emerald-700">Saved at {savedAt.toLocaleTimeString()}</span>
            ) : null}
            <button
              onClick={save}
              disabled={busy}
              className="px-4 py-1.5 text-sm font-bold rounded bg-[color:var(--color-brand-navy)] text-white disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save owners"}
            </button>
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-slate-500">Only an NBFC Admin can change step owners.</p>
      )}
    </section>
  );
}
