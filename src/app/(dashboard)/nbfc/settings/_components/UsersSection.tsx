"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Copy, Mail, Phone, Send, Trash2, UserPlus, Users, X } from "lucide-react";
import {
  NBFC_ORIGINATION_ROLES,
  NBFC_MONITORING_ROLES,
  NBFC_ROLE_LABELS,
} from "@/lib/nbfc/origination-roles";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import type { HierarchyStep } from "@/lib/nbfc/approval-hierarchy-rules";
import ApprovalHierarchyPanel, { MenuTicks, StepTicks, memberLabel, type HierarchyMember } from "./ApprovalHierarchyPanel";
import { CHILD_DEFAULT_NAV, CHILD_DEFAULT_TITLE, type NbfcNavId } from "@/lib/nbfc/portal-nav";

interface Member extends HierarchyMember {
  user_id: string;
  role: string;
  email: string | null;
  name: string | null;
  phone?: string | null;
  // E-387 — parent/child CIBIL approval hierarchy.
  parent_user_id?: string | null;
  delegated_steps?: string[];
  created_at: string | null;
}

interface Props {
  tenantId: string;
  currentUserId: string | null;
  members: Member[];
  /** nbfc_admin — may edit the approval hierarchy. */
  canManage?: boolean;
  cibilReviewEnabledAt?: string | null;
}

// Addendum V0.2 §7.2 — five origination roles.
const ROLE_OPTIONS = NBFC_ORIGINATION_ROLES;
function roleLabel(role: string): string {
  return (NBFC_ROLE_LABELS as Record<string, string>)[role] ?? role;
}

const LABEL = "mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300";
const INPUT =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-100 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900";

const AVATAR_TONES = [
  "bg-sky-100 text-sky-700",
  "bg-emerald-100 text-emerald-700",
  "bg-violet-100 text-violet-700",
  "bg-amber-100 text-amber-700",
  "bg-rose-100 text-rose-700",
  "bg-teal-100 text-teal-700",
];
function avatarTone(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}
function initialsOf(s: string): string {
  const base = s.includes("@") ? s.split("@")[0] : s;
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export default function UsersSection({ currentUserId, members, canManage = false, cibilReviewEnabledAt = null }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  // E-387 — "Reports to" (parent) for a new child login + its delegated steps.
  const [parentId, setParentId] = useState("");
  const [steps, setSteps] = useState<HierarchyStep[]>([]);
  // E-388 — menus + designation for the new child.
  const [nav, setNav] = useState<NbfcNavId[] | null>([...CHILD_DEFAULT_NAV]);
  const [title, setTitle] = useState(CHILD_DEFAULT_TITLE);
  // Parents = members who report to nobody.
  const parentOptions = members.filter((m) => !m.parent_user_id);
  // A selected value is either "sys:<role>" (system role) or "custom:<roleId>".
  const [roleValue, setRoleValue] = useState("sys:viewer");
  const [customRoles, setCustomRoles] = useState<{ id: string; name: string }[]>([]);
  // Set once when a brand-new login is provisioned — shown to the admin to relay.
  const [newLogin, setNewLogin] = useState<{ email: string; password: string } | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

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
    setNewLogin(null);
    try {
      const body: {
        email: string;
        name?: string;
        role?: string;
        role_id?: string;
        phone?: string;
        parent_user_id?: string;
        delegated_steps?: string[];
        allowed_nav?: string[] | null;
        title?: string;
      } = {
        email: email.trim(),
      };
      if (name.trim()) body.name = name.trim();
      if (phone.trim()) body.phone = phone.trim();
      if (parentId) {
        body.parent_user_id = parentId;
        body.delegated_steps = steps;
        body.allowed_nav = nav;
        if (title.trim()) body.title = title.trim();
      }
      if (roleValue.startsWith("custom:")) body.role_id = roleValue.slice("custom:".length);
      else body.role = roleValue.slice("sys:".length);
      const res = await fetch("/api/nbfc/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        created?: boolean;
        tempPassword?: string | null;
        email?: string;
      };
      if (!res.ok) {
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      // A brand-new login was provisioned — surface the one-time password so the
      // admin can relay it. Existing-user links just refresh the list.
      if (j.created && j.tempPassword) {
        setNewLogin({ email: j.email ?? email.trim(), password: j.tempPassword });
      }
      setEmail("");
      setName("");
      setPhone("");
      setParentId("");
      setSteps([]);
      setNav([...CHILD_DEFAULT_NAV]);
      setTitle(CHILD_DEFAULT_TITLE);
      setRoleValue("sys:viewer");
      setInviteOpen(false);
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
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-700">
            <Users className="h-[18px] w-[18px]" />
          </span>
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-slate-100">
              Team members <span className="ml-1 text-sm font-normal text-slate-400">{members.length}</span>
            </h3>
            <p className="text-sm text-slate-500">People who can log in to your NBFC portal.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setInviteOpen((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition ${
            inviteOpen
              ? "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              : "bg-[color:var(--color-brand-navy)] text-white hover:opacity-90"
          }`}
        >
          {inviteOpen ? <X className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />}
          {inviteOpen ? "Close" : "Invite user"}
        </button>
      </div>

      {newLogin ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm space-y-2 dark:border-emerald-800 dark:bg-emerald-900/20">
          <div className="font-semibold text-emerald-800 dark:text-emerald-300">
            New login created — share these once. The user must change the password on first login.
          </div>
          <div className="font-mono text-xs text-slate-700 dark:text-slate-200">
            <div>
              <span className="text-slate-500">Email:</span> {newLogin.email}
            </div>
            <div>
              <span className="text-slate-500">Password:</span> {newLogin.password}
            </div>
          </div>
          <div className="flex gap-3 text-xs">
            <button
              onClick={() =>
                navigator.clipboard?.writeText(
                  `Login: ${newLogin.email}\nPassword: ${newLogin.password}`,
                )
              }
              className="inline-flex items-center gap-1 font-bold text-emerald-700 hover:underline dark:text-emerald-300"
            >
              <Copy className="h-3.5 w-3.5" /> Copy credentials
            </button>
            <button onClick={() => setNewLogin(null)} className="text-slate-500 hover:underline">
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {inviteOpen ? (
      <div className="rounded-xl border border-sky-100 bg-sky-50/50 p-5 dark:border-sky-900 dark:bg-sky-900/10">
        <h4 className="mb-1 font-semibold text-slate-900 dark:text-slate-100">Invite a new user</h4>
        <p className="mb-4 text-xs text-slate-500">
          If the email already has an iTarang account we link it. Otherwise a new login is created
          and a one-time password is shown for you to share.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className={LABEL}>Email *</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              className={INPUT}
              placeholder="user@example.com"
            />
          </div>
          <div>
            <label className={LABEL}>
              Full name <span className="font-normal text-slate-400">(for new logins)</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              className={INPUT}
              placeholder="Jane Partner"
            />
          </div>
          <div>
            <label className={LABEL}>
              Mobile <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input
              type="tel"
              inputMode="numeric"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={busy}
              className={INPUT}
              placeholder="98XXXXXXXX"
            />
          </div>
          <div>
            <label className={LABEL}>Role</label>
            <select
              value={roleValue}
              onChange={(e) => setRoleValue(e.target.value)}
              disabled={busy}
              className={INPUT}
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={`sys:${r}`}>
                  {roleLabel(r)}
                </option>
              ))}
              <optgroup label="Monitoring & Recovery">
                {NBFC_MONITORING_ROLES.map((r) => (
                  <option key={r} value={`sys:${r}`}>
                    {roleLabel(r)}
                  </option>
                ))}
              </optgroup>
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
          <div>
            <label className={LABEL}>
              Reports to <span className="font-normal text-slate-400">(needs approval from)</span>
            </label>
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              disabled={busy}
              className={INPUT}
            >
              <option value="">Nobody — works independently</option>
              {parentOptions.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.name ?? m.email ?? m.user_id}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <button
              onClick={invite}
              disabled={busy}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              {busy ? "Sending invite…" : "Send invite"}
            </button>
          </div>
        </div>
        {parentId ? (
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-xs">
            <p className="font-semibold text-emerald-900">
              Child user — uploads the CIBIL report and a note and sends them to{" "}
              {memberLabel(members, parentId)} for approval. After approval{" "}
              {memberLabel(members, parentId)} owns the lead.
            </p>
            <label className="mt-2 block">
              <span className="block mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                Designation (shown instead of &ldquo;NBFC Partner&rdquo;)
              </span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={busy}
                maxLength={64}
                className="border border-slate-300 rounded px-2 py-1 text-sm w-56 bg-white"
              />
            </label>
            <p className="mt-2 text-slate-600">Menus this user can see and open:</p>
            <MenuTicks value={nav} onChange={setNav} disabled={busy} />
            <p className="mt-2 text-slate-600">After approval this user may ALSO do (tick only what you allow):</p>
            <StepTicks value={steps} onChange={setSteps} disabled={busy} />
          </div>
        ) : null}
      </div>
      ) : null}

      {error ? (
        <div className="rounded-lg bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</div>
      ) : null}

      {members.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
          No team members yet. Click <b>Invite user</b> to add someone.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {members.map((m) => {
            const display = m.name ?? m.email ?? m.user_id;
            const isApprover = members.some((c) => c.parent_user_id === m.user_id);
            const isMe = m.user_id === currentUserId;
            return (
              <li key={m.user_id} className="flex flex-wrap items-center gap-4 px-4 py-3.5 hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
                <span
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold ${avatarTone(m.user_id)}`}
                >
                  {initialsOf(display)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium text-slate-900 dark:text-slate-100">{display}</span>
                    {isMe ? (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">You</span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
                    {m.email ? (
                      <span className="inline-flex items-center gap-1">
                        <Mail className="h-3 w-3" /> {m.email}
                      </span>
                    ) : null}
                    {m.phone ? (
                      <span className="inline-flex items-center gap-1 tabular-nums">
                        <Phone className="h-3 w-3" /> {m.phone}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700">
                    {roleLabel(m.role)}
                  </span>
                  {m.parent_user_id ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800">
                      Reports to {memberLabel(members, m.parent_user_id)}
                    </span>
                  ) : isApprover ? (
                    <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-800">
                      Approver
                    </span>
                  ) : null}
                </div>
                <div className="hidden w-28 text-right text-xs text-slate-400 sm:block">
                  {m.created_at ? `Joined ${new Date(m.created_at).toLocaleDateString("en-IN")}` : ""}
                </div>
                <div className="w-9 text-right">
                  {!isMe ? (
                    <button
                      onClick={() => remove(m.user_id)}
                      disabled={busy}
                      title="Remove user"
                      aria-label={`Remove ${display}`}
                      className="rounded-lg p-2 text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ApprovalHierarchyPanel
        members={members}
        canManage={canManage}
        cibilReviewEnabledAt={cibilReviewEnabledAt}
        currentUserId={currentUserId}
      />
    </section>
  );
}
