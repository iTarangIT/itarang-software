"use client";

// Ecofy lead list (E-307): Hot first, then longest waiting. The Sales Head can
// select rows and assign / reassign them; ASM / ISR get the same table,
// read-only, scoped to their own leads by the server page.

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ECOFY_ROLE_LABEL, ECOFY_STAGE_LABELS } from "@/lib/ecofy/access";
import { formatIst, formatQueueAge, StageBadge, TemperatureBadge } from "./badges";
import { EcofyAssignBar, useEcofyAssignees } from "./EcofyAssignBar";
import { inputCls } from "./ui";

export interface EcofyLeadTableRow {
    id: string;
    caseNo: string | null;
    customerName: string | null;
    customerMobile: string | null;
    city: string | null;
    productInterest: string | null;
    segment: string | null;
    temperature: string | null;
    stage: string | null;
    subStatus: string | null;
    queueEnteredAt: string | null;
    assignedTo: string | null;
    assigneeName: string | null;
    assignedRole: string | null;
    nextFollowUpAt: string | null;
    nextAppointmentAt: string | null;
}

export function EcofyLeadTable({
    rows,
    hrefBase,
    selectable,
    showAssignee,
    filters = true,
    emptyText,
}: {
    rows: EcofyLeadTableRow[];
    hrefBase: string;
    selectable: boolean;
    showAssignee: boolean;
    filters?: boolean;
    emptyText: string;
}) {
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
    const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
    const toggle = (id: string) =>
        setSelected((s) => {
            const n = new Set(s);
            if (n.has(id)) n.delete(id);
            else n.add(id);
            return n;
        });

    return (
        <div className="space-y-3">
            {filters && <Filters showAssignee={showAssignee} />}
            {rows.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-500">{emptyText}</div>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                    <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                            <tr>
                                {selectable && (
                                    <th className="w-10 px-3 py-3">
                                        <input
                                            type="checkbox"
                                            aria-label="Select all"
                                            checked={allSelected}
                                            onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
                                        />
                                    </th>
                                )}
                                <th className="px-4 py-3">Case</th>
                                <th className="px-4 py-3">Customer</th>
                                <th className="px-4 py-3">Temperature</th>
                                <th className="px-4 py-3">Stage</th>
                                {showAssignee && <th className="px-4 py-3">Owner</th>}
                                <th className="px-4 py-3">City</th>
                                <th className="px-4 py-3">Product</th>
                                <th className="px-4 py-3">Next</th>
                                <th className="px-4 py-3">In queue</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {rows.map((l) => (
                                <tr key={l.id} className={selected.has(l.id) ? "bg-sky-50/60" : "hover:bg-gray-50"}>
                                    {selectable && (
                                        <td className="px-3 py-3">
                                            <input type="checkbox" aria-label={`Select ${l.caseNo ?? l.id}`} checked={selected.has(l.id)} onChange={() => toggle(l.id)} />
                                        </td>
                                    )}
                                    <td className="px-4 py-3 font-medium">
                                        <Link href={`${hrefBase}/${l.id}`} className="text-blue-700 hover:underline">
                                            {l.caseNo ?? l.id.slice(0, 8)}
                                        </Link>
                                        {l.segment && <div className="text-xs text-gray-500">{l.segment}</div>}
                                    </td>
                                    <td className="px-4 py-3">
                                        <div className="text-gray-900">{l.customerName ?? "—"}</div>
                                        <div className="text-xs text-gray-500">{l.customerMobile ?? ""}</div>
                                    </td>
                                    <td className="px-4 py-3">
                                        <TemperatureBadge value={l.temperature} />
                                    </td>
                                    <td className="px-4 py-3">
                                        <StageBadge value={l.stage} subStatus={l.subStatus} />
                                    </td>
                                    {showAssignee && (
                                        <td className="px-4 py-3 text-gray-700">
                                            {l.assigneeName ? (
                                                <>
                                                    {l.assigneeName}
                                                    <div className="text-xs text-gray-500">{ECOFY_ROLE_LABEL[l.assignedRole ?? ""] ?? l.assignedRole}</div>
                                                </>
                                            ) : (
                                                <span className="text-amber-700">Unassigned</span>
                                            )}
                                        </td>
                                    )}
                                    <td className="px-4 py-3 text-gray-700">{l.city ?? "—"}</td>
                                    <td className="px-4 py-3 text-gray-700">{l.productInterest ?? "—"}</td>
                                    <td className="px-4 py-3 text-xs text-gray-700">
                                        {l.nextAppointmentAt && <div>Meeting {formatIst(l.nextAppointmentAt)}</div>}
                                        {l.nextFollowUpAt && (
                                            <div className={new Date(l.nextFollowUpAt) <= new Date() ? "font-medium text-red-700" : ""}>
                                                Follow-up {formatIst(l.nextFollowUpAt)}
                                            </div>
                                        )}
                                        {!l.nextAppointmentAt && !l.nextFollowUpAt && "—"}
                                    </td>
                                    <td className="px-4 py-3 text-gray-700">{formatQueueAge(l.queueEnteredAt)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {selectable && (
                <EcofyAssignBar
                    leadIds={[...selected]}
                    reassign={selectedRows.some((r) => r.assignedTo)}
                    onDone={() => setSelected(new Set())}
                />
            )}
        </div>
    );
}

function Filters({ showAssignee }: { showAssignee: boolean }) {
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const assignees = useEcofyAssignees(showAssignee);
    const [q, setQ] = useState(params.get("q") ?? "");

    const set = (key: string, value: string) => {
        const next = new URLSearchParams(params.toString());
        if (value) next.set(key, value);
        else next.delete(key);
        router.push(`${pathname}?${next.toString()}`);
    };

    return (
        <div className="flex flex-wrap items-end gap-2">
            <form
                className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs font-medium text-gray-600"
                onSubmit={(e) => {
                    e.preventDefault();
                    set("q", q.trim());
                }}
            >
                Search
                <input className={inputCls} placeholder="Name, case no., mobile, city" value={q} onChange={(e) => setQ(e.target.value)} />
            </form>
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                Stage
                <select className={inputCls} value={params.get("stage") ?? ""} onChange={(e) => set("stage", e.target.value)}>
                    <option value="">Any</option>
                    {Object.entries(ECOFY_STAGE_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>
                            {k} · {v}
                        </option>
                    ))}
                </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                Temperature
                <select className={inputCls} value={params.get("temperature") ?? ""} onChange={(e) => set("temperature", e.target.value)}>
                    <option value="">Any</option>
                    <option value="HOT">Hot</option>
                    <option value="WARM">Warm</option>
                </select>
            </label>
            {showAssignee && (
                <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                    Owner
                    <select className={inputCls} value={params.get("assignee") ?? ""} onChange={(e) => set("assignee", e.target.value)}>
                        <option value="">Anyone</option>
                        <option value="none">Unassigned</option>
                        {(assignees.data ?? []).map((a) => (
                            <option key={a.id} value={a.id}>
                                {a.name} ({ECOFY_ROLE_LABEL[a.role] ?? a.role})
                            </option>
                        ))}
                    </select>
                </label>
            )}
        </div>
    );
}
