"use client";

/**
 * Settings → Users → Access & approval hierarchy (E-387 + E-388).
 *
 * The NBFC admin, per user:
 *   - Designation — shown in the header / profile instead of "NBFC Partner"
 *     (a child defaults to "Credit Verifier");
 *   - Menus — which sidebar menus the user can see and open (all, or ticked);
 *   - Reports to — makes the user a CHILD who sends the CIBIL report to that
 *     parent for approval;
 *   - Steps — what a child may ALSO do on a lead after the parent approves.
 * Plus the tenant switch "CIBIL approval required before any other step".
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { HIERARCHY_STEPS, type HierarchyStep } from "@/lib/nbfc/approval-hierarchy-rules";
import { CHILD_DEFAULT_NAV, CHILD_DEFAULT_TITLE, DEFAULT_TITLE, NBFC_NAV, type NbfcNavId } from "@/lib/nbfc/portal-nav";

export interface HierarchyMember {
  user_id: string;
  email: string | null;
  name: string | null;
  parent_user_id?: string | null;
  delegated_steps?: string[];
  allowed_nav?: string[] | null;
  title?: string | null;
}

export function memberLabel(members: HierarchyMember[], userId: string): string {
  const m = members.find((x) => x.user_id === userId);
  return m?.name ?? m?.email ?? "the approver";
}

function ordered<T extends string>(all: readonly T[], picked: readonly string[], add?: T): T[] {
  return all.filter((k) => k === add || picked.includes(k));
}

export function StepTicks({
  value,
  onChange,
  disabled,
}: {
  value: HierarchyStep[];
  onChange: (v: HierarchyStep[]) => void;
  disabled?: boolean;
}) {
  const keys = HIERARCHY_STEPS.map((s) => s.key);
  return (
    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
      {HIERARCHY_STEPS.map((s) => (
        <label key={s.key} className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={value.includes(s.key)}
            disabled={disabled}
            onChange={(e) =>
              onChange(e.target.checked ? ordered(keys, value, s.key) : value.filter((k) => k !== s.key))
            }
          />
          {s.label}
        </label>
      ))}
    </div>
  );
}

/** Menu ticks. value null ⇒ "All menus". `locked` ids cannot be unticked. */
export function MenuTicks({
  value,
  onChange,
  disabled,
  locked = [],
}: {
  value: NbfcNavId[] | null;
  onChange: (v: NbfcNavId[] | null) => void;
  disabled?: boolean;
  locked?: NbfcNavId[];
}) {
  const ids = NBFC_NAV.map((n) => n.id);
  const all = value == null;
  return (
    <div className="mt-1.5 space-y-1.5">
      <label className="inline-flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-300">
        <input
          type="checkbox"
          checked={all}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked ? null : ordered(ids, [...CHILD_DEFAULT_NAV, ...locked]))}
        />
        All menus
      </label>
      {!all ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {NBFC_NAV.map((n) => {
            const isLocked = locked.includes(n.id);
            return (
              <label key={n.id} className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={value.includes(n.id) || isLocked}
                  disabled={disabled || isLocked}
                  onChange={(e) =>
                    onChange(e.target.checked ? ordered(ids, value, n.id) : value.filter((k) => k !== n.id))
                  }
                />
                {n.label}
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function stepsOf(m: HierarchyMember): HierarchyStep[] {
  const keys = HIERARCHY_STEPS.map((s) => s.key) as string[];
  return (m.delegated_steps ?? []).filter((k): k is HierarchyStep => keys.includes(k));
}
function navOf(m: HierarchyMember): NbfcNavId[] | null {
  const ids = NBFC_NAV.map((n) => n.id) as string[];
  if (Array.isArray(m.allowed_nav)) return m.allowed_nav.filter((k): k is NbfcNavId => ids.includes(k));
  // A child with no explicit list is on the default (Acquire only).
  return m.parent_user_id ? [...CHILD_DEFAULT_NAV] : null;
}
function titleOf(m: HierarchyMember): string {
  return m.title?.trim() || (m.parent_user_id ? CHILD_DEFAULT_TITLE : DEFAULT_TITLE);
}
function navSummary(nav: NbfcNavId[] | null): string {
  if (nav == null) return "All menus";
  if (nav.length === 0) return "No menus";
  return NBFC_NAV.filter((n) => nav.includes(n.id))
    .map((n) => n.label)
    .join(", ");
}

export default function ApprovalHierarchyPanel({
  members,
  canManage,
  cibilReviewEnabledAt,
  currentUserId = null,
}: {
  members: HierarchyMember[];
  canManage: boolean;
  cibilReviewEnabledAt: string | null;
  currentUserId?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftParent, setDraftParent] = useState("");
  const [draftSteps, setDraftSteps] = useState<HierarchyStep[]>([]);
  const [draftNav, setDraftNav] = useState<NbfcNavId[] | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  const gateOn = !!cibilReviewEnabledAt;

  async function call(url: string, method: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error((j.error ?? `HTTP ${res.status}`).replace(/^(BAD_REQUEST|CONFLICT|FORBIDDEN): /, ""));
      setEditing(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(m: HierarchyMember) {
    setEditing(m.user_id);
    setDraftParent(m.parent_user_id ?? "");
    setDraftSteps(stepsOf(m));
    setDraftNav(navOf(m));
    setDraftTitle(m.title ?? "");
    setError(null);
  }

  function onParentChange(v: string) {
    // Becoming a child: start from the child defaults (Acquire only).
    if (v && !draftParent && draftNav == null) setDraftNav([...CHILD_DEFAULT_NAV]);
    setDraftParent(v);
  }

  return (
    <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-3">
      <div>
        <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">
          Access &amp; approval hierarchy
        </h3>
        <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
          For each user, set the designation they see, the menus they can open, and who they report to.
          A child (e.g. a Credit Verifier) uploads the CIBIL report and a note and sends it to the person
          they report to. While it waits the child cannot act. After approval the parent owns the lead;
          the child can only do the steps you tick. A rejection needs a reason and closes the file.
        </p>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={gateOn}
          disabled={!canManage || busy}
          onChange={(e) =>
            call("/api/nbfc/settings/approval-hierarchy", "PUT", { cibil_required: e.target.checked })
          }
        />
        <span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">
            CIBIL approval required before any other step
          </span>
          <span className="block text-[11px] text-slate-500">
            {gateOn
              ? `On since ${new Date(cibilReviewEnabledAt!).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })} — applies to files assigned from then on; older files keep moving.`
              : "Off — nobody has to upload a CIBIL report before working a file."}
          </span>
        </span>
      </label>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs uppercase tracking-widest text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-bold">User</th>
              <th className="px-3 py-2 text-left font-bold">Designation</th>
              <th className="px-3 py-2 text-left font-bold">Menus</th>
              <th className="px-3 py-2 text-left font-bold">Reports to</th>
              <th className="px-3 py-2 text-left font-bold">After approval can also do</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) =>
              editing === m.user_id ? (
                <tr key={m.user_id} className="border-t border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30">
                  <td colSpan={6} className="px-3 py-3">
                    <div className="font-medium mb-2">{m.name ?? m.email ?? m.user_id}</div>
                    <div className="grid gap-3 text-xs">
                      <div className="flex flex-wrap gap-4">
                        <label>
                          <span className="block mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                            Designation
                          </span>
                          <input
                            value={draftTitle}
                            onChange={(e) => setDraftTitle(e.target.value)}
                            disabled={busy}
                            maxLength={64}
                            placeholder={draftParent ? CHILD_DEFAULT_TITLE : DEFAULT_TITLE}
                            className="border border-slate-300 rounded px-2 py-1 text-sm w-56"
                          />
                        </label>
                        <label>
                          <span className="block mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                            Reports to
                          </span>
                          <select
                            value={draftParent}
                            onChange={(e) => onParentChange(e.target.value)}
                            disabled={busy || m.user_id === currentUserId}
                            className="border border-slate-300 rounded px-2 py-1 text-sm"
                          >
                            <option value="">Nobody (independent)</option>
                            {members
                              .filter((p) => p.user_id !== m.user_id && !p.parent_user_id)
                              .map((p) => (
                                <option key={p.user_id} value={p.user_id}>
                                  {p.name ?? p.email ?? p.user_id}
                                </option>
                              ))}
                          </select>
                        </label>
                      </div>
                      <div>
                        <span className="block text-[10px] font-bold uppercase tracking-widest text-slate-500">
                          Menus this user can see and open
                        </span>
                        <MenuTicks
                          value={draftNav}
                          onChange={setDraftNav}
                          disabled={busy}
                          locked={m.user_id === currentUserId ? ["settings"] : []}
                        />
                      </div>
                      {draftParent ? (
                        <div>
                          <span className="block text-[10px] font-bold uppercase tracking-widest text-slate-500">
                            After the CIBIL approval this user may also do
                          </span>
                          <StepTicks value={draftSteps} onChange={setDraftSteps} disabled={busy} />
                        </div>
                      ) : null}
                      <div className="flex gap-2">
                        <button
                          onClick={() =>
                            call(`/api/nbfc/users/${m.user_id}`, "PATCH", {
                              parent_user_id: draftParent || null,
                              delegated_steps: draftParent ? draftSteps : [],
                              allowed_nav:
                                draftNav && m.user_id === currentUserId && !draftNav.includes("settings")
                                  ? [...draftNav, "settings"]
                                  : draftNav,
                              title: draftTitle.trim() || null,
                            })
                          }
                          disabled={busy}
                          className="px-3 py-1 text-xs font-bold rounded bg-[color:var(--color-brand-navy)] text-white disabled:opacity-50"
                        >
                          {busy ? "Saving…" : "Save"}
                        </button>
                        <button
                          onClick={() => setEditing(null)}
                          disabled={busy}
                          className="text-xs text-slate-500 hover:underline"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={m.user_id} className="border-t border-slate-100 dark:border-slate-800 align-top">
                  <td className="px-3 py-2 font-medium">{m.name ?? m.email ?? m.user_id}</td>
                  <td className="px-3 py-2 text-xs">{titleOf(m)}</td>
                  <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300 max-w-[220px]">
                    {navSummary(navOf(m))}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {m.parent_user_id ? (
                      memberLabel(members, m.parent_user_id)
                    ) : members.some((c) => c.parent_user_id === m.user_id) ? (
                      <span className="font-semibold text-sky-800 dark:text-sky-300">Approver (parent)</span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300 max-w-[220px]">
                    {m.parent_user_id
                      ? stepsOf(m).length
                        ? HIERARCHY_STEPS.filter((s) => stepsOf(m).includes(s.key))
                            .map((s) => s.label)
                            .join(", ")
                        : "Only the CIBIL report (view-only after approval)"
                      : "All steps their role allows"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canManage ? (
                      <button
                        onClick={() => startEdit(m)}
                        disabled={busy}
                        className="text-xs font-semibold text-[color:var(--color-brand-sky)] hover:underline disabled:opacity-50"
                      >
                        Edit
                      </button>
                    ) : null}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {error ? <div className="px-3 py-2 bg-red-50 text-red-700 text-xs rounded">{error}</div> : null}
    </div>
  );
}
