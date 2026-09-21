// NeoDove → Agents (review R-03).
//
// Every NeoDove call names the agent who dialled it, but NeoDove has no user
// ids and no read API, so the CRM could not tell whose call it was — every CC
// call landed with no performer and counted on nobody's numbers. Here an admin
// confirms, once per agent, which CRM user they are. Saving re-points that
// agent's past calls, and every call after it arrives attributed.
//
// The picker PRE-FILLS a name-based suggestion but never saves it: CRM names
// are first names only, and a guess that goes wrong the day a second "Nidhi"
// joins is invisible — the numbers still look plausible.

"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, CheckCircle2, Info, Loader2 } from "lucide-react";

type AgentRow = {
    key: string;
    name: string;
    calls: number;
    unattributed: number;
    last_call_at: string | null;
    user_id: string | null;
    user_name: string | null;
    suggested_user_id: string | null;
};

type MappableUser = { user_id: string; name: string | null; role: string | null };

type Summary = {
    agents: AgentRow[];
    users: MappableUser[];
    total_calls: number;
    unattributed_calls: number;
    calls_without_agent: number;
    can_edit: boolean;
};

const QUERY_KEY = ["neodove-agents"];

function fmtDate(iso: string | null): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    });
}

function roleLabel(role: string | null): string {
    return (role ?? "").replace(/_/g, " ");
}

export default function NeodoveAgentsPage() {
    const qc = useQueryClient();
    const { data, isLoading, error } = useQuery<Summary>({
        queryKey: QUERY_KEY,
        queryFn: async () => {
            const res = await fetch("/api/neodove/agents", { cache: "no-store" });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Could not load agents");
            return json.data;
        },
    });

    const unattributed = data?.unattributed_calls ?? 0;

    return (
        <div className="max-w-5xl mx-auto py-8 px-6 min-h-screen bg-gray-50">
            <Link
                href="/leads/neodove-campaigns"
                className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
            >
                <ArrowLeft className="w-4 h-4" /> NeoDove
            </Link>

            <h1 className="mt-3 text-2xl font-bold text-gray-900 tracking-tight">
                NeoDove agents
            </h1>
            <p className="text-sm text-gray-500 mt-1">
                Link each NeoDove agent to their CRM login, so their calls count on
                their own numbers.
            </p>

            <div className="mt-5 rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3 text-sm text-blue-900 flex gap-2">
                <Info className="w-4 h-4 mt-0.5 shrink-0" />
                <p>
                    NeoDove tells us the agent&apos;s name on every call, but not who they
                    are in the CRM. Until an agent is linked here, their calls appear
                    on nobody&apos;s row in the Sales dashboard, the daily email and
                    Funnel by Owner. Saving a link also credits the agent&apos;s past
                    calls.
                </p>
            </div>

            {data && (
                <div
                    className={`mt-4 rounded-xl border px-4 py-3 text-sm flex items-center gap-2 ${
                        unattributed > 0
                            ? "border-amber-200 bg-amber-50 text-amber-900"
                            : "border-emerald-200 bg-emerald-50 text-emerald-900"
                    }`}
                >
                    {unattributed > 0 ? (
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                    ) : (
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                    )}
                    <span>
                        <strong className="tabular-nums">
                            {unattributed.toLocaleString("en-IN")}
                        </strong>{" "}
                        of {data.total_calls.toLocaleString("en-IN")} NeoDove calls are not
                        credited to anyone.
                        {data.calls_without_agent > 0 &&
                            ` ${data.calls_without_agent.toLocaleString("en-IN")} of them arrived with no agent name and cannot be linked.`}
                    </span>
                </div>
            )}

            {isLoading && (
                <div className="mt-8 flex items-center gap-2 text-sm text-gray-500">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading agents…
                </div>
            )}
            {error && (
                <p className="mt-6 text-sm text-red-600">{(error as Error).message}</p>
            )}

            {data && data.agents.length === 0 && (
                <p className="mt-6 text-sm text-gray-500">
                    No NeoDove calls with an agent name have arrived yet.
                </p>
            )}

            {data && data.agents.length > 0 && (
                <div className="mt-5 overflow-x-auto rounded-xl border border-gray-200 bg-white">
                    <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wider">
                            <tr>
                                <th className="px-4 py-3 text-left font-semibold">NeoDove agent</th>
                                <th className="px-4 py-3 text-right font-semibold">Calls</th>
                                <th className="px-4 py-3 text-right font-semibold">Not credited</th>
                                <th className="px-4 py-3 text-left font-semibold">Last call</th>
                                <th className="px-4 py-3 text-left font-semibold">CRM user</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {data.agents.map((a) => (
                                <AgentRowView
                                    key={a.key}
                                    agent={a}
                                    users={data.users}
                                    canEdit={data.can_edit}
                                    onSaved={() => qc.invalidateQueries({ queryKey: QUERY_KEY })}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {data && !data.can_edit && (
                <p className="mt-3 text-xs text-gray-500">
                    Only admin, CEO or sales head can change these links.
                </p>
            )}
        </div>
    );
}

function AgentRowView({
    agent,
    users,
    canEdit,
    onSaved,
}: {
    agent: AgentRow;
    users: MappableUser[];
    canEdit: boolean;
    onSaved: () => void;
}) {
    const initial = agent.user_id ?? agent.suggested_user_id ?? "";
    const [choice, setChoice] = useState(initial);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

    const saved = agent.user_id ?? "";
    const dirty = choice !== saved;
    const isSuggestion = !agent.user_id && !!agent.suggested_user_id && choice === agent.suggested_user_id;
    // A mapped user who was deactivated is not in `users`; keep them visible.
    const mappedMissing = !!agent.user_id && !users.some((u) => u.user_id === agent.user_id);

    async function save() {
        setBusy(true);
        setMsg(null);
        try {
            const res = await fetch("/api/neodove/agents", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ agent: agent.name, user_id: choice || null }),
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Save failed");
            const moved: number = json.data.moved;
            setMsg({
                ok: true,
                text: choice
                    ? `Linked · ${moved.toLocaleString("en-IN")} past call${moved === 1 ? "" : "s"} credited`
                    : `Unlinked · ${moved.toLocaleString("en-IN")} call${moved === 1 ? "" : "s"} no longer credited`,
            });
            onSaved();
        } catch (e) {
            setMsg({ ok: false, text: (e as Error).message });
        } finally {
            setBusy(false);
        }
    }

    return (
        <tr className="align-top">
            <td className="px-4 py-3 font-medium text-gray-900">{agent.name}</td>
            <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                {agent.calls.toLocaleString("en-IN")}
            </td>
            <td
                className={`px-4 py-3 text-right tabular-nums ${
                    agent.unattributed > 0 ? "text-amber-700 font-semibold" : "text-gray-400"
                }`}
            >
                {agent.unattributed.toLocaleString("en-IN")}
            </td>
            <td className="px-4 py-3 text-gray-600">{fmtDate(agent.last_call_at)}</td>
            <td className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                    <select
                        value={choice}
                        disabled={!canEdit || busy}
                        onChange={(e) => {
                            setChoice(e.target.value);
                            setMsg(null);
                        }}
                        className="min-w-[200px] rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm disabled:bg-gray-50"
                    >
                        <option value="">— Not linked —</option>
                        {mappedMissing && (
                            <option value={agent.user_id!}>
                                {agent.user_name ?? "Inactive user"} (inactive)
                            </option>
                        )}
                        {users.map((u) => (
                            <option key={u.user_id} value={u.user_id}>
                                {u.name ?? "(no name)"} · {roleLabel(u.role)}
                            </option>
                        ))}
                    </select>
                    {canEdit && (dirty || (!!saved && agent.unattributed > 0)) && (
                        <button
                            onClick={save}
                            disabled={busy}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60"
                        >
                            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                            {/* Already linked but calls arrived uncredited (e.g.
                                before the deploy that reads the link) — re-saving
                                the same link credits them. */}
                            {dirty ? "Save" : `Credit ${agent.unattributed.toLocaleString("en-IN")}`}
                        </button>
                    )}
                </div>
                {isSuggestion && (
                    <p className="mt-1 text-xs text-amber-700">
                        Suggested from the name — check it&apos;s the right person, then Save.
                    </p>
                )}
                {msg && (
                    <p className={`mt-1 text-xs ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>
                        {msg.text}
                    </p>
                )}
            </td>
        </tr>
    );
}
