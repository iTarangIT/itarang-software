"use client";

// Sales Head → ASM / ISR assignment (E-307). Used as a sticky bar on the lead
// lists (bulk) and inline on a lead's detail page (single).

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ecofyGet, ecofyPost } from "./client";
import { inputCls } from "./ui";

type Assignee = { id: string; name: string; email: string | null; role: string };
type AssignResult = {
    assigned: string[];
    skipped: Array<{ leadId: string; caseNo: string | null; reason: string }>;
    ecofyNotUpdated?: Array<{ leadId: string; caseNo: string | null; reason: string }>;
};

export function useEcofyAssignees(enabled = true) {
    return useQuery({
        // Own key on purpose: ["admin-user-options"] is shared by other pickers
        // with different role filters.
        queryKey: ["ecofy-assignees"],
        enabled,
        staleTime: 60_000,
        queryFn: async () => (await ecofyGet<{ assignees: Assignee[] }>("/api/ecofy/assignees")).assignees,
    });
}

export function EcofyAssignBar({
    leadIds,
    reassign,
    onDone,
    compact,
}: {
    leadIds: string[];
    /** True when any selected lead already has an owner — a reason is then required. */
    reassign: boolean;
    onDone?: () => void;
    compact?: boolean;
}) {
    const router = useRouter();
    const assignees = useEcofyAssignees(leadIds.length > 0);
    const [target, setTarget] = useState("");
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);
    const groups = useMemo(() => {
        const list = assignees.data ?? [];
        return [
            { label: "ASM (field)", rows: list.filter((a) => a.role === "asm") },
            { label: "ISR (inside sales)", rows: list.filter((a) => a.role === "inside_sales_rep") },
        ];
    }, [assignees.data]);

    if (leadIds.length === 0) return null;

    async function submit() {
        setBusy(true);
        try {
            const r = await ecofyPost<AssignResult>("/api/ecofy/assign", { leadIds, targetUserId: target, reason: reason || undefined });
            if (r.assigned.length) toast.success(`Assigned ${r.assigned.length} lead${r.assigned.length > 1 ? "s" : ""}`);
            for (const s of r.skipped.slice(0, 5)) toast.warning(`${s.caseNo ?? "Lead"}: ${s.reason}`);
            if (r.skipped.length > 5) toast.warning(`…and ${r.skipped.length - 5} more skipped`);
            // The assignment stands either way; this only says Ecofy's own copy
            // of the case was not updated yet (it still shows S1 there). The
            // reminder ticker re-sends the event every 5 minutes until it lands.
            if (r.ecofyNotUpdated?.length) {
                toast.info(
                    `Assigned in the CRM. Ecofy not updated yet for ${r.ecofyNotUpdated.length} lead${r.ecofyNotUpdated.length > 1 ? "s" : ""} (${r.ecofyNotUpdated[0].reason}) — retried automatically every 5 min.`,
                );
            }
            setReason("");
            onDone?.();
            router.refresh();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Assign failed");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div
            className={
                compact
                    ? "flex flex-wrap items-end gap-2"
                    : "sticky bottom-3 z-20 flex flex-wrap items-end gap-2 rounded-xl border border-gray-200 bg-white p-3 shadow-lg"
            }
        >
            {!compact && (
                <span className="self-center text-sm font-medium text-gray-900">
                    {leadIds.length} selected
                </span>
            )}
            <label className="flex min-w-[220px] flex-col gap-1 text-xs font-medium text-gray-600">
                {reassign ? "Reassign to" : "Assign to"}
                <select className={inputCls} value={target} onChange={(e) => setTarget(e.target.value)} disabled={assignees.isLoading}>
                    <option value="">{assignees.isLoading ? "Loading…" : "Choose ASM or ISR"}</option>
                    {groups.map((g) =>
                        g.rows.length ? (
                            <optgroup key={g.label} label={g.label}>
                                {g.rows.map((a) => (
                                    <option key={a.id} value={a.id}>
                                        {a.name}
                                    </option>
                                ))}
                            </optgroup>
                        ) : null,
                    )}
                </select>
            </label>
            <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs font-medium text-gray-600">
                {reassign ? "Reason (mandatory to reassign)" : "Note (optional)"}
                <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <button
                type="button"
                disabled={busy || !target || (reassign && reason.trim().length < 3)}
                onClick={submit}
                className="rounded-md bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
                {busy ? "Assigning…" : reassign ? "Reassign" : "Assign"}
            </button>
        </div>
    );
}
