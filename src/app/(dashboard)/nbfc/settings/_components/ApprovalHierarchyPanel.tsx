"use client";

/**
 * E-387 — Settings → Users → Approval hierarchy.
 *
 * The NBFC admin:
 *   1. switches on "CIBIL approval required before any other step";
 *   2. sets who each user reports to (child → parent) and ticks the steps a
 *      child may ALSO do after the parent approves the CIBIL report.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { HIERARCHY_STEPS, type HierarchyStep } from "@/lib/nbfc/approval-hierarchy-rules";

export interface HierarchyMember {
  user_id: string;
  email: string | null;
  name: string | null;
  parent_user_id?: string | null;
  delegated_steps?: string[];
}

export function memberLabel(members: HierarchyMember[], userId: string): string {
  const m = members.find((x) => x.user_id === userId);
  return m?.name ?? m?.email ?? "the approver";
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
  return (
    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
      {HIERARCHY_STEPS.map((s) => (
        <label key={s.key} className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={value.includes(s.key)}
            disabled={disabled}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? HIERARCHY_STEPS.map((x) => x.key).filter((k) => k === s.key || value.includes(k))
                  : value.filter((k) => k !== s.key),
              )
            }
          />
          {s.label}
        </label>
      ))}
    </div>
  );
}

function stepsOf(m: HierarchyMember): HierarchyStep[] {
  const keys = HIERARCHY_STEPS.map((s) => s.key) as string[];
  return (m.delegated_steps ?? []).filter((k): k is HierarchyStep => keys.includes(k));
}

export default function ApprovalHierarchyPanel({
  members,
  canManage,
  cibilReviewEnabledAt,
}: {
  members: HierarchyMember[];
  canManage: boolean;
  cibilReviewEnabledAt: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftParent, setDraftParent] = useState("");
  const [draftSteps, setDraftSteps] = useState<HierarchyStep[]>([]);

  const gateOn = !!cibilReviewEnabledAt;
  const children = members.filter((m) => m.parent_user_id);

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
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
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
    setError(null);
  }

  return (
    <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-3">
      <div>
        <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">
          Approval hierarchy (CIBIL)
        </h3>
        <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
          A child user uploads the CIBIL report and a note and sends it to the user they report to.
          While it waits, the child cannot act. After approval the parent owns the lead; the child
          can only do the steps ticked below. A rejection needs a reason and closes the file.
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

      <table className="w-full text-sm">
        <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs uppercase tracking-widest text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left font-bold">User</th>
            <th className="px-3 py-2 text-left font-bold">Reports to</th>
            <th className="px-3 py-2 text-left font-bold">After approval can also do</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) =>
            editing === m.user_id ? (
              <tr key={m.user_id} className="border-t border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30">
                <td className="px-3 py-2 align-top font-medium">{m.name ?? m.email ?? m.user_id}</td>
                <td className="px-3 py-2 align-top">
                  <select
                    value={draftParent}
                    onChange={(e) => setDraftParent(e.target.value)}
                    disabled={busy}
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
                </td>
                <td className="px-3 py-2 align-top text-xs">
                  {draftParent ? (
                    <StepTicks value={draftSteps} onChange={setDraftSteps} disabled={busy} />
                  ) : (
                    <span className="text-slate-400">Independent users are not limited by the hierarchy.</span>
                  )}
                </td>
                <td className="px-3 py-2 align-top text-right whitespace-nowrap">
                  <button
                    onClick={() =>
                      call(`/api/nbfc/users/${m.user_id}`, "PATCH", {
                        parent_user_id: draftParent || null,
                        delegated_steps: draftParent ? draftSteps : [],
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
                    className="ml-2 text-xs text-slate-500 hover:underline"
                  >
                    Cancel
                  </button>
                </td>
              </tr>
            ) : (
              <tr key={m.user_id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-3 py-2 font-medium">{m.name ?? m.email ?? m.user_id}</td>
                <td className="px-3 py-2 text-xs">
                  {m.parent_user_id ? (
                    memberLabel(members, m.parent_user_id)
                  ) : members.some((c) => c.parent_user_id === m.user_id) ? (
                    <span className="font-semibold text-sky-800 dark:text-sky-300">Approver (parent)</span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
                  {m.parent_user_id
                    ? stepsOf(m).length
                      ? HIERARCHY_STEPS.filter((s) => stepsOf(m).includes(s.key))
                          .map((s) => s.label)
                          .join(", ")
                      : "Only the CIBIL report (view-only after approval)"
                    : m.parent_user_id === undefined
                      ? "—"
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
      {children.length === 0 ? (
        <p className="text-[11px] text-slate-500">
          No child users yet. Add one above with &ldquo;Reports to&rdquo;, or click Edit on an existing user.
        </p>
      ) : null}
      {error ? <div className="px-3 py-2 bg-red-50 text-red-700 text-xs rounded">{error}</div> : null}
    </div>
  );
}
