"use client";

/**
 * Users & Roles → Roles section (BRD Addendum V0.3.1 §15.8 — custom RBAC).
 * Lists the five read-only system roles and the tenant's custom roles, and lets
 * an admin clone-to-customise: create/edit a custom role by toggling permissions
 * from the 32-permission catalogue. Deactivate is soft and blocked while users
 * are assigned (server-enforced).
 */
import { useCallback, useEffect, useState } from "react";
import { confirmDialog } from "@/components/ui/confirm-dialog";

type PermDef = { key: string; label: string };
type Group = { key: string; label: string; permissions: PermDef[] };
type SystemRole = { key: string; label: string; permissions: string[]; users: number };
type CustomRole = {
  id: string;
  name: string;
  description: string | null;
  base_role: string;
  is_active: boolean;
  permissions: string[];
  users: number;
};
type RolesResp = {
  ok: boolean;
  canEdit?: boolean;
  catalogue?: Group[];
  systemRoles?: SystemRole[];
  customRoles?: CustomRole[];
  error?: string;
};

type Draft = { id: string | null; name: string; base_role: string; description: string; permissions: Set<string> };

export default function RolesSection() {
  const [data, setData] = useState<RolesResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/nbfc/roles");
      const j = (await res.json()) as RolesResp;
      if (!j.ok) throw new Error(j.error ?? "Failed to load roles");
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const canEdit = data?.canEdit ?? false;
  const catalogue = data?.catalogue ?? [];
  const systemRoles = data?.systemRoles ?? [];
  const customRoles = (data?.customRoles ?? []).filter((r) => r.is_active);

  function startCreate(cloneFrom?: SystemRole) {
    setDraft({
      id: null,
      name: cloneFrom ? `${cloneFrom.label} (custom)` : "",
      base_role: cloneFrom?.key ?? "viewer",
      description: "",
      permissions: new Set(cloneFrom?.permissions ?? []),
    });
  }
  function startEdit(r: CustomRole) {
    setDraft({ id: r.id, name: r.name, base_role: r.base_role, description: r.description ?? "", permissions: new Set(r.permissions) });
  }

  async function save() {
    if (!draft) return;
    if (draft.name.trim().length < 2) {
      setError("Role name must be at least 2 characters.");
      return;
    }
    if (draft.permissions.size === 0) {
      setError("Select at least one permission.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: draft.name.trim(),
        base_role: draft.base_role,
        description: draft.description || null,
        permissions: Array.from(draft.permissions),
      };
      const res = draft.id
        ? await fetch(`/api/nbfc/roles/${draft.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        : await fetch("/api/nbfc/roles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      setDraft(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(r: CustomRole) {
    const ok = await confirmDialog({ title: "Deactivate role?", message: `Deactivate "${r.name}"? Users must be reassigned first.`, confirmText: "Deactivate", variant: "danger" });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/roles/${r.id}`, { method: "DELETE" });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggle(key: string) {
    setDraft((d) => {
      if (!d) return d;
      const next = new Set(d.permissions);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...d, permissions: next };
    });
  }

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500">Roles</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Five built-in roles plus your own custom roles (clone a built-in, then tweak the permissions).
          </p>
        </div>
        {canEdit && !draft && (
          <button onClick={() => startCreate()} className="px-3 py-1.5 rounded-md bg-[color:var(--color-brand-navy)] text-white text-xs font-semibold">
            New custom role
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {!draft && (
        <div className="space-y-2">
          {systemRoles.map((r) => (
            <div key={r.key} className="flex items-center justify-between border border-slate-200 rounded-md px-3 py-2">
              <div>
                <span className="text-sm font-semibold text-slate-700">{r.label}</span>
                <span className="ml-2 text-[10px] uppercase tracking-wider bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">System</span>
                <p className="text-xs text-slate-500">{r.permissions.length} permissions · {r.users} user{r.users === 1 ? "" : "s"}</p>
              </div>
              {canEdit && (
                <button onClick={() => startCreate(r)} className="text-[11px] text-[color:var(--color-brand-sky)] underline">
                  Clone &amp; customise
                </button>
              )}
            </div>
          ))}
          {customRoles.map((r) => (
            <div key={r.id} className="flex items-center justify-between border border-sky-200 bg-sky-50/40 rounded-md px-3 py-2">
              <div>
                <span className="text-sm font-semibold text-slate-700">{r.name}</span>
                <span className="ml-2 text-[10px] uppercase tracking-wider bg-sky-100 text-sky-700 px-1.5 py-0.5 rounded">Custom · from {r.base_role}</span>
                <p className="text-xs text-slate-500">{r.permissions.length} permissions · {r.users} user{r.users === 1 ? "" : "s"}</p>
              </div>
              {canEdit && (
                <div className="flex items-center gap-3">
                  <button onClick={() => startEdit(r)} className="text-[11px] text-[color:var(--color-brand-sky)] underline">Edit</button>
                  <button onClick={() => deactivate(r)} disabled={busy} className="text-[11px] text-red-600 underline disabled:opacity-50">Deactivate</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {draft && (
        <div className="space-y-3 border border-slate-200 rounded-md p-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-[11px] text-slate-500 font-semibold">
              Role name
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="mt-1 w-full text-sm border border-slate-200 rounded-md px-2 py-1.5 font-normal" />
            </label>
            <label className="text-[11px] text-slate-500 font-semibold">
              Based on (legacy compatibility)
              <select value={draft.base_role} onChange={(e) => setDraft({ ...draft, base_role: e.target.value })} disabled={!!draft.id} className="mt-1 w-full text-sm border border-slate-200 rounded-md px-2 py-1.5 font-normal disabled:bg-slate-100">
                {systemRoles.map((r) => (
                  <option key={r.key} value={r.key}>{r.label}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="text-[11px] text-slate-500 font-semibold block">
            Description (optional)
            <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className="mt-1 w-full text-sm border border-slate-200 rounded-md px-2 py-1.5 font-normal" />
          </label>

          <div className="space-y-3">
            {catalogue.map((g) => (
              <div key={g.key}>
                <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold mb-1">{g.label}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                  {g.permissions.map((p) => (
                    <label key={p.key} className="flex items-center gap-2 text-xs text-slate-600">
                      <input type="checkbox" checked={draft.permissions.has(p.key)} onChange={() => toggle(p.key)} />
                      {p.label}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button onClick={save} disabled={busy} className="px-3 py-1.5 rounded-md bg-[color:var(--color-brand-navy)] text-white text-xs font-semibold disabled:opacity-50">
              {busy ? "Saving…" : draft.id ? "Save role" : "Create role"}
            </button>
            <button onClick={() => setDraft(null)} disabled={busy} className="px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 text-xs font-semibold">
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
