"use client";

// BRD §0.11 Zone 3 — 11 collapsible alert panels. Counts arrive with the
// dashboard payload; drill-down rows load lazily on expand. Open-lead panels
// support multi-select → admin bulk actions (BRD §0.11 Bulk Actions).

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
    ALERT_PANELS,
    ALERT_PANEL_LABELS,
    type AlertPanelKey,
    type AlertPanelRow,
} from "@/lib/admin/types";
import { BulkActionBar } from "./BulkActionBar";

// Panels whose rows are open dealer_leads — eligible for bulk actions.
const SELECTABLE: Set<AlertPanelKey> = new Set([
    "no_touch_5d",
    "no_touch_10d",
    "awaiting_decision_14d",
    "asm_no_activity",
    "out_of_territory_handoffs",
]);

export function AlertPanels({
    counts,
    filterQs,
}: {
    counts: Record<AlertPanelKey, number>;
    filterQs: string;
}) {
    const qc = useQueryClient();
    const [selected, setSelected] = useState<Set<string>>(new Set());

    function toggle(id: string) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    function clearAndRefresh() {
        setSelected(new Set());
        qc.invalidateQueries({ queryKey: ["admin-dashboard"] });
        qc.invalidateQueries({ queryKey: ["admin-alert"] });
    }

    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold text-brand-navy">
                    Alert Panels
                </h2>
                {selected.size > 0 && (
                    <BulkActionBar
                        selectedIds={[...selected]}
                        onClear={() => setSelected(new Set())}
                        onActionDone={clearAndRefresh}
                    />
                )}
            </div>
            <div className="divide-y divide-border">
                {ALERT_PANELS.map((key) => (
                    <AlertPanel
                        key={key}
                        panelKey={key}
                        count={counts[key] ?? 0}
                        filterQs={filterQs}
                        selectable={SELECTABLE.has(key)}
                        selected={selected}
                        onToggle={toggle}
                    />
                ))}
            </div>
        </div>
    );
}

function AlertPanel({
    panelKey,
    count,
    filterQs,
    selectable,
    selected,
    onToggle,
}: {
    panelKey: AlertPanelKey;
    count: number;
    filterQs: string;
    selectable: boolean;
    selected: Set<string>;
    onToggle: (id: string) => void;
}) {
    const [open, setOpen] = useState(false);

    const query = useQuery<{ success: true; data: { rows: AlertPanelRow[] } }>({
        queryKey: ["admin-alert", panelKey, filterQs],
        enabled: open,
        queryFn: async () => {
            const res = await fetch(
                `/api/admin/dashboard/alerts/${panelKey}${filterQs ? `?${filterQs}` : ""}`,
                { cache: "no-store" },
            );
            if (!res.ok) throw new Error("Failed to load panel");
            return res.json();
        },
    });

    const rows = query.data?.data.rows ?? [];

    return (
        <div>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-bg/60"
            >
                {open ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-ink-muted" />
                ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-ink-muted" />
                )}
                <span className="flex-1 text-sm text-ink">
                    {ALERT_PANEL_LABELS[panelKey]}
                </span>
                <Badge
                    variant={count > 0 ? "danger" : "muted"}
                    className="min-w-[1.75rem] justify-center tabular-nums"
                >
                    {count}
                </Badge>
            </button>

            {open && (
                <div className="px-4 pb-3">
                    {query.isLoading && (
                        <div className="flex items-center gap-2 py-3 text-xs text-ink-muted">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Loading…
                        </div>
                    )}
                    {query.error && (
                        <div className="py-3 text-xs text-danger">
                            Failed to load rows.
                        </div>
                    )}
                    {!query.isLoading && rows.length === 0 && (
                        <div className="py-3 text-xs text-ink-muted">
                            Nothing here — all clear.
                        </div>
                    )}
                    {rows.length > 0 && (
                        <ul className="space-y-1">
                            {rows.map((r) => (
                                <li
                                    key={r.id}
                                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-bg"
                                >
                                    {selectable && (
                                        <input
                                            type="checkbox"
                                            checked={selected.has(r.id)}
                                            onChange={() => onToggle(r.id)}
                                            className="shrink-0 accent-brand-sky"
                                        />
                                    )}
                                    <Link
                                        href={r.href}
                                        className="flex min-w-0 flex-1 items-center gap-2"
                                    >
                                        <span className="truncate font-medium text-ink">
                                            {r.primary}
                                        </span>
                                        {r.secondary && (
                                            <span className="truncate text-xs text-ink-muted">
                                                {r.secondary}
                                            </span>
                                        )}
                                        {r.meta && (
                                            <span className="ml-auto shrink-0 text-[11px] text-ink-muted">
                                                {r.meta}
                                            </span>
                                        )}
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}
