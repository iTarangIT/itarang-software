"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Tabs } from "@/components/ui/tabs";
import type { SettingsBundle } from "@/lib/admin/types";
import { AssignmentConfigForm } from "./AssignmentConfigForm";
import { HolidayCalendarManager } from "./HolidayCalendarManager";
import { NotificationAccessManager } from "./NotificationAccessManager";
import { TerritoryManager } from "./TerritoryManager";

type Tab = "assignment" | "holidays" | "territories" | "notifications";

const TABS: { id: Tab; label: string }[] = [
    { id: "assignment", label: "Assignment Config" },
    { id: "holidays", label: "Holiday Calendar" },
    { id: "territories", label: "ASM Territories" },
    { id: "notifications", label: "Notification Access" },
];

// The first three tabs are fed by one bundled query; Notification Access owns
// its own. Kept as a set so the loading and error blocks below can skip the
// tabs that do not depend on the bundle — otherwise this tab would sit behind a
// spinner for three tables it never reads, and would show an error banner for a
// request that has nothing to do with it.
const BUNDLE_TABS = new Set<Tab>(["assignment", "holidays", "territories"]);

export function SettingsView() {
    const [tab, setTab] = useState<Tab>("assignment");

    const query = useQuery<{ success: true; data: SettingsBundle }>({
        queryKey: ["admin-settings"],
        queryFn: async () => {
            const res = await fetch("/api/admin/settings", { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load settings");
            return res.json();
        },
    });
    const data = query.data?.data;

    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="px-2 pt-1">
                <Tabs
                    tabs={TABS.map((t) => ({ value: t.id, label: t.label }))}
                    value={tab}
                    onValueChange={(v) => setTab(v as Tab)}
                />
            </div>

            <div className="p-5">
                {query.isLoading && BUNDLE_TABS.has(tab) && (
                    <div className="flex items-center justify-center py-10 text-ink-muted">
                        <Loader2 className="h-5 w-5 animate-spin mr-2" />
                        Loading settings…
                    </div>
                )}
                {query.error && BUNDLE_TABS.has(tab) && (
                    <div className="flex items-center gap-2 text-sm text-danger">
                        <AlertTriangle className="h-4 w-4" />
                        {(query.error as Error).message}
                    </div>
                )}
                {data && tab === "assignment" && (
                    <AssignmentConfigForm config={data.assignment_config} />
                )}
                {data && tab === "holidays" && (
                    <HolidayCalendarManager holidays={data.holidays} />
                )}
                {data && tab === "territories" && (
                    <TerritoryManager territories={data.territories} />
                )}
                {tab === "notifications" && <NotificationAccessManager />}
            </div>
        </div>
    );
}
