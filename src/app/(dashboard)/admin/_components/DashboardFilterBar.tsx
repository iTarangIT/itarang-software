"use client";

// BRD §0.11 Zone 4 — dashboard filter bar. Edits a local draft; "Apply" lifts
// it to the dashboard so a half-typed filter doesn't refetch on every keypress.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Filter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LEAD_STATUS } from "@/lib/lifecycle/transitions";
import { UPLOAD_SEGMENTS, type DashboardFilters } from "@/lib/admin/types";

const SOURCE_OPTIONS = [
    "ai_dialer_lead",
    "manual_upload_lead",
    "reference",
    "trade_show",
    "other",
];

const selectCls =
    "h-9 rounded-lg border border-border bg-surface px-2 text-sm text-ink transition-shadow focus:outline-none focus:border-brand-sky focus:ring-4 focus:ring-brand-sky/15";

export function DashboardFilterBar({
    filters,
    onApply,
}: {
    filters: DashboardFilters;
    onApply: (f: DashboardFilters) => void;
}) {
    // Local draft — the parent's `filters` only changes via this bar's own
    // Apply / Clear, so no prop-sync effect is needed.
    const [draft, setDraft] = useState<DashboardFilters>(filters);

    const usersQuery = useQuery<{
        success: true;
        data: {
            users: { user_id: string; name: string | null; role: string | null }[];
        };
    }>({
        queryKey: ["admin-user-options"],
        queryFn: async () => {
            const res = await fetch("/api/admin/users", { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load users");
            return res.json();
        },
        staleTime: 5 * 60 * 1000,
    });
    const users = usersQuery.data?.data.users ?? [];

    const set = <K extends keyof DashboardFilters>(
        k: K,
        v: DashboardFilters[K],
    ) => setDraft((d) => ({ ...d, [k]: v }));

    const activeCount = Object.values(filters).filter(
        (v) => v !== null && v !== undefined && v !== "" && v !== false,
    ).length;

    return (
        <div className="rounded-xl border border-border bg-surface px-4 py-3 shadow-card">
            <div className="flex flex-wrap items-end gap-3">
                <div className="flex items-center gap-1.5 pb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                    <Filter className="h-3.5 w-3.5" />
                    Filters
                    {activeCount > 0 && (
                        <span className="rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] text-brand-700">
                            {activeCount}
                        </span>
                    )}
                </div>

                <Field label="From">
                    <input
                        type="date"
                        value={draft.date_from ?? ""}
                        onChange={(e) => set("date_from", e.target.value || null)}
                        className={selectCls}
                    />
                </Field>
                <Field label="To">
                    <input
                        type="date"
                        value={draft.date_to ?? ""}
                        onChange={(e) => set("date_to", e.target.value || null)}
                        className={selectCls}
                    />
                </Field>

                <Field label="Owner">
                    <select
                        value={draft.owner_id ?? ""}
                        onChange={(e) => set("owner_id", e.target.value || null)}
                        className={selectCls}
                    >
                        <option value="">All owners</option>
                        {users.map((u) => (
                            <option key={u.user_id} value={u.user_id}>
                                {u.name ?? u.user_id} ({u.role})
                            </option>
                        ))}
                    </select>
                </Field>

                <Field label="Status">
                    <select
                        value={draft.status ?? ""}
                        onChange={(e) => set("status", e.target.value || null)}
                        className={selectCls}
                    >
                        <option value="">All statuses</option>
                        {LEAD_STATUS.map((s) => (
                            <option key={s} value={s}>
                                {s}
                            </option>
                        ))}
                    </select>
                </Field>

                <Field label="Source">
                    <select
                        value={draft.source ?? ""}
                        onChange={(e) => set("source", e.target.value || null)}
                        className={selectCls}
                    >
                        <option value="">All sources</option>
                        {SOURCE_OPTIONS.map((s) => (
                            <option key={s} value={s}>
                                {s}
                            </option>
                        ))}
                    </select>
                </Field>

                <Field label="Segment">
                    <select
                        value={draft.segment ?? ""}
                        onChange={(e) => set("segment", e.target.value || null)}
                        className={selectCls}
                    >
                        <option value="">All segments</option>
                        {UPLOAD_SEGMENTS.map((s) => (
                            <option key={s} value={s}>
                                {s}
                            </option>
                        ))}
                    </select>
                </Field>

                <Field label="State">
                    <Input
                        value={draft.state ?? ""}
                        onChange={(e) => set("state", e.target.value || null)}
                        placeholder="State"
                        className="h-9 w-32"
                    />
                </Field>
                <Field label="City">
                    <Input
                        value={draft.city ?? ""}
                        onChange={(e) => set("city", e.target.value || null)}
                        placeholder="City"
                        className="h-9 w-32"
                    />
                </Field>

                <label className="flex items-center gap-1.5 pb-2 text-xs text-ink-muted">
                    <input
                        type="checkbox"
                        checked={!!draft.follow_up_due_today}
                        onChange={(e) =>
                            set("follow_up_due_today", e.target.checked)
                        }
                        className="accent-brand-sky"
                    />
                    Follow-up due today
                </label>
                <label className="flex items-center gap-1.5 pb-2 text-xs text-ink-muted">
                    <input
                        type="checkbox"
                        checked={!!draft.reactivated_only}
                        onChange={(e) =>
                            set("reactivated_only", e.target.checked)
                        }
                        className="accent-brand-sky"
                    />
                    Reactivated only
                </label>

                <div className="ml-auto flex items-center gap-2 pb-1">
                    {activeCount > 0 && (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                                setDraft({});
                                onApply({});
                            }}
                        >
                            <X className="mr-1 h-3.5 w-3.5" />
                            Clear
                        </Button>
                    )}
                    <Button type="button" size="sm" onClick={() => onApply(draft)}>
                        Apply
                    </Button>
                </div>
            </div>
        </div>
    );
}

function Field({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}) {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                {label}
            </span>
            {children}
        </label>
    );
}
