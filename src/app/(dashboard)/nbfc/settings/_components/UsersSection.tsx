"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { NBFC_ORIGINATION_ROLES, NBFC_ROLE_LABELS } from "@/lib/nbfc/origination-roles";
import { confirmDialog } from "@/components/ui/confirm-dialog";

interface Member {
  user_id: string;
  role: string;
  email: string | null;
  name: string | null;
  created_at: string | null;
}

interface Props {
  tenantId: string;
  currentUserId: string | null;
  members: Member[];
}

// Addendum V0.2 §7.2 — five origination roles.
const ROLE_OPTIONS = NBFC_ORIGINATION_ROLES;
function roleLabel(role: string): string {
  return (NBFC_ROLE_LABELS as Record<string, string>)[role] ?? role;
}

export default function UsersSection({ currentUserId, members }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  // A selected value is either "sys:<role>" (system role) or "custom:<roleId>".
  const [roleValue, setRoleValue] = useState("sys:viewer");
  const [customRoles, setCustomRoles] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/nbfc/roles")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j: { customRoles?: { id: string; name: string; is_active: boolean }[] }) => {
        if (!cancelled) setCustomRoles((j.customRoles ?? []).filter((r) => r.is_active).map((r) => ({ id: r.id, name: r.name })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function invite() {
    if (!email.trim().includes("@")) {
      setError("Provide a valid email.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: { email: string; role?: string; role_id?: string } = { email: email.trim() };
      if (roleValue.startsWith("custom:")) body.role_id = roleValue.slice("custom:".length);
      else body.role = roleValue.slice("sys:".length);
      const res = await fetch("/api/nbfc/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setEmail("");
      setRoleValue("sys:viewer");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string) {
    const ok = await confirmDialog({
      title: "Remove user?",
      message: "Remove this user from the tenant?",
      confirmText: "Remove",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/users/${userId}`, { method: "DELETE" });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
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
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500">Users</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          NBFC partner users with access to this tenant&apos;s portal.
        </p>
      </div>

      <table className="w-full text-sm">
        <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs uppercase tracking-widest text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left font-bold">User</th>
            <th className="px-3 py-2 text-left font-bold">Role</th>
            <th className="px-3 py-2 text-left font-bold">Joined</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {members.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-3 py-6 text-center text-slate-500">
                No members yet. Invite someone below.
              </td>
            </tr>
          ) : (
            members.map((m) => (
              <tr key={m.user_id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-3 py-2">
                  <div className="font-medium">{m.name ?? m.email ?? m.user_id}</div>
                  <div className="text-xs text-slate-500">{m.email ?? ""}</div>
                </td>
                <td className="px-3 py-2 text-xs font-bold">{roleLabel(m.role)}</td>
                <td className="px-3 py-2 text-xs text-slate-500 tabular-nums">
                  {m.created_at ? new Date(m.created_at).toLocaleDateString() : "—"}
                </td>
                <td className="px-3 py-2 text-right">
                  {m.user_id !== currentUserId ? (
                    <button
                      onClick={() => remove(m.user_id)}
                      disabled={busy}
                      className="text-xs text-red-600 hover:underline disabled:opacity-50"
                    >
                      Remove
                    </button>
                  ) : (
                    <span className="text-xs text-slate-400">You</span>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div className="border-t border-slate-200 dark:border-slate-800 pt-4">
        <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">
          Invite user
        </h3>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              className="w-full border border-slate-300 rounded px-2 py-1 text-sm"
              placeholder="user@example.com"
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
              Role
            </label>
            <select
              value={roleValue}
              onChange={(e) => setRoleValue(e.target.value)}
              disabled={busy}
              className="border border-slate-300 rounded px-2 py-1 text-sm"
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={`sys:${r}`}>
                  {roleLabel(r)}
                </option>
              ))}
              {customRoles.length > 0 && (
                <optgroup label="Custom roles">
                  {customRoles.map((r) => (
                    <option key={r.id} value={`custom:${r.id}`}>
                      {r.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <button
            onClick={invite}
            disabled={busy}
            className="px-4 py-1.5 text-sm font-bold rounded bg-[color:var(--color-brand-navy)] text-white disabled:opacity-50"
          >
            {busy ? "Inviting…" : "Invite"}
          </button>
        </div>
        {error ? (
          <div className="mt-2 px-3 py-2 bg-red-50 text-red-700 text-xs rounded">{error}</div>
        ) : null}
        <p className="text-[11px] text-slate-500 mt-2">
          The invited email must already have an iTarang account; we link it to this tenant.
        </p>
      </div>
    </section>
  );
}
