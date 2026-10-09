"use client";

// Accounts tab (tracker P1-1 / P1-2) — every dealer account with its owner,
// who onboarded it, lead vs direct, and the GSTIN-missing flag. The "No
// owner" queue shows a suggested owner as a HINT; nothing is assigned until
// someone clicks.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Search, Sparkles, UserMinus, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LeaverMoveDialog } from "./LeaverMoveDialog";
import { AssignOwnerDialog, api, fmtDate, inputCls, OwnerSelect, useOwners } from "./shared";

type Suggested = { user_id: string; name: string | null; basis: string };

export type AccountRow = {
    id: string;
    name: string;
    gstin: string | null;
    gstin_missing: boolean;
    city: string | null;
    state: string | null;
    status: string;
    /** ID 5 — closed by hand as "Lost / closed dealer" (E-332). */
    closed?: boolean;
    closed_reason?: string | null;
    created_at: string | null;
    owner_user_id: string | null;
    owner_name: string | null;
    onboarded_by_user_id: string | null;
    onboarded_by_name: string | null;
    came_through: "lead" | "direct" | null;
    source_dealer_lead_id: string | null;
    source_application_id: string | null;
    suggested_owner: Suggested | null;
};

type ListResponse = {
    rows: AccountRow[];
    filtered_total: number;
    counts: { total: number; no_owner: number; gstin_missing: number };
    limit: number;
    offset: number;
};

type Tab = "all" | "no_owner" | "gstin_missing" | "closed";
const PAGE = 100;

export function CameThroughBadge({ value }: { value: string | null }) {
    if (value === "lead")
        return <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">Lead</span>;
    if (value === "direct")
        return (
            <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700">
                Direct onboarding
            </span>
        );
    return <span className="text-[11px] text-ink-muted">—</span>;
}

export function AccountsView() {
    const qc = useQueryClient();
    const owners = useOwners();
    const [tab, setTab] = useState<Tab>("all");
    const [q, setQ] = useState("");
    const [debouncedQ, setDebouncedQ] = useState("");
    const [ownerFilter, setOwnerFilter] = useState("");
    const [cameThrough, setCameThrough] = useState("");
    const [page, setPage] = useState(0);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [dialog, setDialog] = useState<null | "assign" | "suggested" | "leaver">(null);
    const [flash, setFlash] = useState<string | null>(null);

    // Any filter change goes back to page 1 and drops the selection.
    const resetPaging = () => {
        setPage(0);
        setSelected(new Set());
    };
    useEffect(() => {
        const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
        return () => clearTimeout(t);
    }, [q]);

    const params = useMemo(() => {
        const p = new URLSearchParams();
        if (debouncedQ) p.set("q", debouncedQ);
        if (tab === "no_owner") p.set("owner", "none");
        else if (ownerFilter) p.set("owner", ownerFilter);
        if (tab === "gstin_missing") p.set("gstin_missing", "1");
        if (tab === "closed") p.set("status", "closed");
        if (cameThrough) p.set("came_through", cameThrough);
        p.set("limit", String(PAGE));
        p.set("offset", String(page * PAGE));
        return p.toString();
    }, [debouncedQ, tab, ownerFilter, cameThrough, page]);

    const { data, isLoading, isFetching, error } = useQuery<ListResponse>({
        queryKey: ["admin-accounts", params],
        queryFn: () => api(`/api/admin/accounts?${params}`),
        placeholderData: (prev) => prev,
    });

    const rows = data?.rows ?? [];
    const counts = data?.counts;
    const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
    const selectedRows = rows.filter((r) => selected.has(r.id));
    const withSuggestion = selectedRows.filter((r) => !r.owner_user_id && r.suggested_owner);

    const toggle = (id: string) =>
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    const toggleAll = () =>
        setSelected((prev) => {
            const next = new Set(prev);
            if (allOnPageSelected) rows.forEach((r) => next.delete(r.id));
            else rows.forEach((r) => next.add(r.id));
            return next;
        });

    const done = (msg: string) => {
        setDialog(null);
        setSelected(new Set());
        setFlash(msg);
        qc.invalidateQueries({ queryKey: ["admin-accounts"] });
        qc.invalidateQueries({ queryKey: ["admin-accounts-owners"] });
    };

    // "Assign suggested": one request per suggested owner. Still a manual click.
    const assignSuggested = async ({ effectiveFrom, reason }: { effectiveFrom: string | null; reason: string }) => {
        const byOwner = new Map<string, string[]>();
        for (const r of withSuggestion) {
            const k = r.suggested_owner!.user_id;
            byOwner.set(k, [...(byOwner.get(k) ?? []), r.id]);
        }
        let changed = 0;
        const failures: string[] = [];
        for (const [ownerId, ids] of byOwner) {
            try {
                const res = await api<{ changed: string[] }>("/api/admin/accounts/assign", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ account_ids: ids, owner_user_id: ownerId, effective_from: effectiveFrom, reason }),
                });
                changed += res.changed.length;
            } catch (e) {
                const name = withSuggestion.find((r) => r.suggested_owner?.user_id === ownerId)?.suggested_owner?.name;
                failures.push(`${name ?? ownerId}: ${(e as Error).message}`);
            }
        }
        if (failures.length && changed === 0) throw new Error(failures.join("; "));
        return `Assigned ${changed} account${changed === 1 ? "" : "s"} to their suggested owner` +
            (failures.length ? ` · failed: ${failures.join("; ")}` : "");
    };

    const tabBtn = (t: Tab, label: string, n?: number, tone = "") => (
        <button
            type="button"
            onClick={() => {
                setTab(t);
                resetPaging();
            }}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${tab === t ? "bg-ink text-white border-ink" : `border-border text-ink ${tone}`}`}
        >
            {label}
            {n != null ? ` · ${n}` : ""}
        </button>
    );

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
                {tabBtn("all", "All", counts?.total)}
                {tabBtn("no_owner", "No owner", counts?.no_owner, "bg-amber-50 border-amber-200 text-amber-800")}
                {tabBtn("gstin_missing", "GSTIN missing", counts?.gstin_missing, "bg-rose-50 border-rose-200 text-rose-700")}
                {tabBtn("closed", "Closed")}
                <div className="ml-auto flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setDialog("leaver")}>
                        <UserMinus className="mr-1 h-3.5 w-3.5" /> Move leaver&apos;s accounts
                    </Button>
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-full sm:w-72">
                    <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-muted" />
                    <input
                        className={`${inputCls} pl-8`}
                        placeholder="Search name, code, GSTIN, city, owner"
                        value={q}
                        onChange={(e) => {
                            setQ(e.target.value);
                            resetPaging();
                        }}
                    />
                </div>
                {tab !== "no_owner" && (
                    <div className="w-full sm:w-60">
                        <OwnerSelect
                            value={ownerFilter}
                            onChange={(v) => {
                                setOwnerFilter(v);
                                resetPaging();
                            }}
                            options={owners.data?.current ?? []}
                            placeholder="Any owner"
                        />
                    </div>
                )}
                <select className={`${inputCls} w-full sm:w-48`} value={cameThrough} onChange={(e) => {
                    setCameThrough(e.target.value);
                    resetPaging();
                }}>
                    <option value="">Came through: any</option>
                    <option value="lead">Lead</option>
                    <option value="direct">Direct onboarding</option>
                    <option value="unknown">Not recorded</option>
                </select>
                {isFetching && <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />}
            </div>

            {flash && (
                <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                    <span>{flash}</span>
                    <button type="button" className="underline" onClick={() => setFlash(null)}>
                        Dismiss
                    </button>
                </div>
            )}

            {selected.size > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg/60 px-3 py-2 text-sm">
                    <span className="font-medium text-ink">{selected.size} selected</span>
                    <Button size="sm" onClick={() => setDialog("assign")}>
                        <UserPlus className="mr-1 h-3.5 w-3.5" /> Assign / reassign
                    </Button>
                    {withSuggestion.length > 0 && (
                        <Button size="sm" variant="secondary" onClick={() => setDialog("suggested")}>
                            <Sparkles className="mr-1 h-3.5 w-3.5" /> Assign suggested ({withSuggestion.length})
                        </Button>
                    )}
                    <button type="button" className="ml-auto text-xs text-ink-muted underline" onClick={() => setSelected(new Set())}>
                        Clear
                    </button>
                </div>
            )}

            {error ? (
                <p className="text-sm text-rose-600">{(error as Error).message}</p>
            ) : isLoading && !data ? (
                <div className="flex items-center gap-2 text-sm text-ink-muted">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
            ) : (
                <div className="rounded-xl border border-border bg-surface shadow-card overflow-x-auto">
                    <table className="w-full min-w-[1100px] text-sm">
                        <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                            <tr>
                                <th className="w-8 px-3 py-2">
                                    <input type="checkbox" checked={allOnPageSelected} onChange={toggleAll} aria-label="Select all on page" />
                                </th>
                                <th className="px-3 py-2 text-left font-semibold">Account</th>
                                <th className="px-3 py-2 text-left font-semibold">GSTIN</th>
                                <th className="px-3 py-2 text-left font-semibold">Owner</th>
                                <th className="px-3 py-2 text-left font-semibold">Came through</th>
                                <th className="px-3 py-2 text-left font-semibold">Onboarded by</th>
                                <th className="px-3 py-2 text-left font-semibold">Location</th>
                                <th className="px-3 py-2 text-left font-semibold">Created</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {rows.length === 0 && (
                                <tr>
                                    <td colSpan={8} className="px-3 py-8 text-center text-ink-muted">
                                        No accounts match.
                                    </td>
                                </tr>
                            )}
                            {rows.map((r) => (
                                <tr key={r.id} className={selected.has(r.id) ? "bg-blue-50/40" : undefined}>
                                    <td className="px-3 py-2">
                                        <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.name}`} />
                                    </td>
                                    <td className="px-3 py-2">
                                        <Link href={`/admin/accounts/${encodeURIComponent(r.id)}`} className="font-medium text-ink hover:underline">
                                            {r.name}
                                        </Link>
                                        <div className="text-[11px] text-ink-muted">
                                            {r.id}
                                            {r.status !== "active" ? ` · ${r.status}` : ""}
                                            {r.closed ? ` · closed${r.closed_reason ? ` — ${r.closed_reason}` : ""}` : ""}
                                        </div>
                                    </td>
                                    <td className="px-3 py-2">
                                        {r.gstin_missing ? (
                                            <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700">
                                                <AlertTriangle className="h-3 w-3" /> GSTIN missing
                                            </span>
                                        ) : (
                                            <span className="font-mono text-xs text-ink">{r.gstin}</span>
                                        )}
                                    </td>
                                    <td className="px-3 py-2">
                                        {r.owner_user_id ? (
                                            <span className="text-ink">{r.owner_name ?? r.owner_user_id}</span>
                                        ) : (
                                            <div>
                                                <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                                                    No owner
                                                </span>
                                                {r.suggested_owner && (
                                                    <div className="mt-1 text-[11px] text-ink-muted" title={`Suggested from the ${r.suggested_owner.basis}`}>
                                                        Suggested: {r.suggested_owner.name ?? r.suggested_owner.user_id}{" "}
                                                        <span className="italic">({r.suggested_owner.basis})</span>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-3 py-2">
                                        <CameThroughBadge value={r.came_through} />
                                    </td>
                                    <td className="px-3 py-2 text-ink">{r.onboarded_by_name ?? <span className="text-ink-muted">—</span>}</td>
                                    <td className="px-3 py-2 text-ink">{[r.city, r.state].filter(Boolean).join(", ") || "—"}</td>
                                    <td className="px-3 py-2 text-ink-muted">{fmtDate(r.created_at)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {data && data.filtered_total > PAGE && (
                <div className="flex items-center justify-end gap-2 text-xs text-ink-muted">
                    <span>
                        {page * PAGE + 1}–{Math.min((page + 1) * PAGE, data.filtered_total)} of {data.filtered_total}
                    </span>
                    <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                        Prev
                    </Button>
                    <Button variant="outline" size="sm" disabled={(page + 1) * PAGE >= data.filtered_total} onClick={() => setPage((p) => p + 1)}>
                        Next
                    </Button>
                </div>
            )}

            {dialog === "assign" && (
                <AssignOwnerDialog
                    title={`Assign owner · ${selected.size} account${selected.size === 1 ? "" : "s"}`}
                    accountIds={[...selected]}
                    onClose={() => setDialog(null)}
                    onDone={done}
                />
            )}
            {dialog === "suggested" && (
                <AssignOwnerDialog
                    title={`Assign suggested owners · ${withSuggestion.length}`}
                    description={
                        <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs">
                            {withSuggestion.map((r) => (
                                <li key={r.id}>
                                    <span className="text-ink">{r.name}</span> → {r.suggested_owner!.name ?? r.suggested_owner!.user_id}
                                </li>
                            ))}
                        </ul>
                    }
                    accountIds={withSuggestion.map((r) => r.id)}
                    submit={assignSuggested}
                    onClose={() => setDialog(null)}
                    onDone={done}
                />
            )}
            {dialog === "leaver" && <LeaverMoveDialog onClose={() => setDialog(null)} onDone={done} />}
        </div>
    );
}
