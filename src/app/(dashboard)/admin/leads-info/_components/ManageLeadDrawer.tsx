"use client";

// Right-side drawer that opens when an admin / sales head clicks a row on
// /admin/leads-info. Shows a read-only summary of the lead and a single
// "reassign to any user (any role)" form. Submits to the existing bulk
// reassign endpoint with a one-element lead_ids array.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Phone, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/app/(dashboard)/inside-sales/_components/StatusChip";
import { InterestChip } from "@/app/(dashboard)/inside-sales/_components/InterestChip";
import { IntentBadge } from "@/app/(dashboard)/inside-sales/_components/IntentBadge";
import type { LeadStatus } from "@/lib/lifecycle/transitions";
import { VISIT_OUTCOME_LABELS, type VisitOutcome } from "@/lib/asm/types";
import type { LeadsInfoRow } from "@/lib/admin/leadsInfoQuery";
import type { UserOption } from "@/lib/admin/types";

function pretty(value: string | null | undefined): string {
    if (!value) return "—";
    return value.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDateTime(iso: string | null): string {
    if (!iso) return "—";
    try {
        return new Date(iso).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return "—";
    }
}

type Props = {
    lead: LeadsInfoRow | null;
    onClose: () => void;
};

export function ManageLeadDrawer({ lead, onClose }: Props) {
    const open = lead !== null;
    const queryClient = useQueryClient();

    const [targetUserId, setTargetUserId] = useState("");
    const [reason, setReason] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Reset the form whenever a different lead opens or the drawer closes.
    useEffect(() => {
        setTargetUserId("");
        setReason("");
        setError(null);
        setSubmitting(false);
    }, [lead?.id]);

    // ESC closes the drawer (but not while a save is in flight).
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !submitting) onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, submitting, onClose]);

    // Lock body scroll while open.
    useEffect(() => {
        if (!open) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.body.style.overflow = prev;
        };
    }, [open]);

    const usersQuery = useQuery<{ success: true; data: { users: UserOption[] } }>({
        queryKey: ["admin-user-options"],
        enabled: open,
        queryFn: async () => {
            const res = await fetch("/api/admin/users", { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load users");
            return res.json();
        },
        staleTime: 5 * 60 * 1000,
    });

    // Hide the current owner from the dropdown — reassigning to themselves is a
    // no-op that the API would reject.
    const userOptions = useMemo(() => {
        const list = usersQuery.data?.data.users ?? [];
        return list.filter((u) => u.user_id !== lead?.current_owner_id);
    }, [usersQuery.data, lead?.current_owner_id]);

    async function submit() {
        if (!lead) return;
        if (!targetUserId) {
            setError("Pick a user to reassign to.");
            return;
        }
        if (reason.trim().length < 5) {
            setError("Reason must be at least 5 characters.");
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch("/api/admin/leads/bulk", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "reassign",
                    lead_ids: [lead.id],
                    target_user_id: targetUserId,
                    reason: reason.trim(),
                }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Reassign failed");
            }
            toast.success("Lead reassigned.");
            queryClient.invalidateQueries({ queryKey: ["admin-leads-info"] });
            onClose();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setSubmitting(false);
        }
    }

    if (!open || !lead) return null;

    const outcome = lead.visit_outcome as VisitOutcome | null;
    const region = [lead.city, lead.state].filter(Boolean).join(", ") || "—";

    return (
        <div
            className="fixed inset-0 z-50"
            role="dialog"
            aria-modal="true"
            aria-label="Manage lead"
        >
            <div
                className="absolute inset-0 bg-black/40 transition-opacity"
                onClick={() => {
                    if (!submitting) onClose();
                }}
            />

            <aside className="absolute right-0 top-0 flex h-full w-full max-w-[440px] flex-col bg-white shadow-xl">
                {/* Header */}
                <div className="border-b border-gray-100 px-5 py-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <h2 className="truncate text-base font-semibold text-gray-900">
                                {lead.dealer_name || lead.shop_name || "(unnamed dealer)"}
                            </h2>
                            {lead.shop_name && lead.dealer_name && (
                                <p className="truncate text-[11px] text-gray-500">
                                    {lead.shop_name}
                                </p>
                            )}
                            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-600">
                                <span className="inline-flex items-center gap-1 tabular-nums">
                                    <Phone className="h-3 w-3 text-gray-400" />
                                    {lead.phone || "—"}
                                </span>
                                <span className="text-gray-300">·</span>
                                <span>{region}</span>
                            </div>
                            <div className="mt-2">
                                <StatusChip
                                    status={lead.lead_status as LeadStatus | null}
                                />
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => {
                                if (!submitting) onClose();
                            }}
                            className="rounded p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
                            aria-label="Close"
                            disabled={submitting}
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                {/* Summary */}
                <div className="border-b border-gray-100 px-5 py-4">
                    <dl className="grid grid-cols-3 gap-x-3 gap-y-2.5 text-[11px]">
                        <dt className="col-span-1 text-gray-500">Source</dt>
                        <dd className="col-span-2 text-gray-800">
                            {pretty(lead.source)}
                        </dd>

                        <dt className="col-span-1 text-gray-500">Interest</dt>
                        <dd className="col-span-2 flex flex-wrap items-center gap-1.5">
                            <InterestChip level={lead.interest_level} />
                            <IntentBadge
                                score={lead.final_intent_score}
                                size="sm"
                            />
                        </dd>

                        <dt className="col-span-1 text-gray-500">Owner</dt>
                        <dd className="col-span-2 text-gray-800">
                            {lead.current_owner_name ? (
                                <>
                                    {lead.current_owner_name}
                                    {lead.current_owner_role && (
                                        <span className="ml-1.5 inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                                            {pretty(lead.current_owner_role)}
                                        </span>
                                    )}
                                </>
                            ) : (
                                <span className="text-gray-400">Unassigned</span>
                            )}
                        </dd>

                        <dt className="col-span-1 text-gray-500">ASM</dt>
                        <dd className="col-span-2 text-gray-800">
                            {lead.asm_name || (
                                <span className="text-gray-400">—</span>
                            )}
                        </dd>

                        <dt className="col-span-1 text-gray-500">Latest visit</dt>
                        <dd className="col-span-2 text-gray-800">
                            {lead.visit_status ? (
                                <div className="flex flex-wrap items-center gap-1.5">
                                    <span>{pretty(lead.visit_status)}</span>
                                    {outcome && (
                                        <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700">
                                            {VISIT_OUTCOME_LABELS[outcome]}
                                        </span>
                                    )}
                                </div>
                            ) : (
                                <span className="text-gray-400">No visit yet</span>
                            )}
                        </dd>

                        <dt className="col-span-1 text-gray-500">Last touch</dt>
                        <dd className="col-span-2 text-gray-800 tabular-nums">
                            {fmtDateTime(lead.last_touchpoint_at)}
                        </dd>

                        <dt className="col-span-1 text-gray-500">Assigned</dt>
                        <dd className="col-span-2 text-gray-800 tabular-nums">
                            {fmtDateTime(lead.assigned_at)}
                        </dd>
                    </dl>
                </div>

                {/* Reassign form */}
                <div className="flex-1 overflow-y-auto px-5 py-4">
                    <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                        <RotateCcw className="h-3.5 w-3.5 text-gray-500" />
                        Reassign owner
                    </h3>
                    <p className="mt-1 text-[11px] text-gray-500">
                        Hand the lead to any user across roles. The reason is
                        recorded as a touchpoint on the lead.
                    </p>

                    <div className="mt-4 space-y-3">
                        <div>
                            <label className="mb-1 block text-[11px] font-medium text-gray-600">
                                Reassign to
                            </label>
                            <select
                                value={targetUserId}
                                onChange={(e) => setTargetUserId(e.target.value)}
                                disabled={submitting || usersQuery.isLoading}
                                className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-2 text-sm disabled:bg-gray-50"
                            >
                                <option value="">
                                    {usersQuery.isLoading
                                        ? "Loading users…"
                                        : "Select a user…"}
                                </option>
                                {userOptions.map((u) => (
                                    <option key={u.user_id} value={u.user_id}>
                                        {u.name ?? u.email}
                                        {u.role ? ` · ${pretty(u.role)}` : ""}
                                    </option>
                                ))}
                            </select>
                            {usersQuery.error && (
                                <p className="mt-1 text-[11px] text-rose-600">
                                    Could not load users.
                                </p>
                            )}
                        </div>

                        <div>
                            <label className="mb-1 block text-[11px] font-medium text-gray-600">
                                Reason <span className="text-rose-600">*</span>
                            </label>
                            <textarea
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                rows={4}
                                placeholder="Why is this lead being reassigned?"
                                disabled={submitting}
                                className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-100 disabled:bg-gray-50"
                            />
                            <p className="mt-1 text-[11px] text-gray-400">
                                Minimum 5 characters.
                            </p>
                        </div>

                        {error && (
                            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
                                {error}
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={onClose}
                        disabled={submitting}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        onClick={submit}
                        disabled={submitting || !targetUserId || reason.trim().length < 5}
                    >
                        {submitting && (
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        )}
                        Reassign
                    </Button>
                </div>
            </aside>
        </div>
    );
}
