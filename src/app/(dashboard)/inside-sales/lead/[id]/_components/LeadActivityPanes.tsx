"use client";

/**
 * The left column of the lead detail page, now tabbed: Touchpoint History (what
 * a human did) and AI Call History (what the dialer did).
 *
 * Extracted so BOTH detail views get the tab from one place — AsmLeadDetailView
 * already imports TouchpointHistoryPane and LeadDetailRightPane out of this
 * folder rather than owning copies, and the same reasoning applies here.
 */
import { useState } from "react";

import { Tabs } from "@/components/ui/tabs";
import type { TabItem } from "@/components/ui/tabs";
import type { LeadDetailBundle } from "@/lib/inside-sales/types";

import { AiCallHistoryPane } from "./AiCallHistoryPane";
import { TouchpointHistoryPane } from "./TouchpointHistoryPane";

export function LeadActivityPanes({
    leadId,
    bundle,
}: {
    leadId: string;
    bundle: LeadDetailBundle;
}) {
    const [tab, setTab] = useState<"touchpoints" | "calls">("touchpoints");

    const tabs: TabItem[] = [
        {
            value: "touchpoints",
            label: "Touchpoint History",
            count: bundle.touchpoints.length,
        },
        { value: "calls", label: "AI Call History" },
    ];

    return (
        <div className="flex min-h-0 flex-col border-r border-gray-100 bg-white">
            <div className="shrink-0 px-6 pt-3">
                <Tabs
                    tabs={tabs}
                    value={tab}
                    onValueChange={(v) => setTab(v as "touchpoints" | "calls")}
                />
            </div>
            {/* grid (not block) so the single child stretches to full height —
                both panes own their own overflow-y-auto and need a bounded box
                to scroll inside. */}
            <div className="grid min-h-0 flex-1 overflow-hidden">
                {tab === "touchpoints" ? (
                    <TouchpointHistoryPane
                        leadId={leadId}
                        touchpoints={bundle.touchpoints}
                        statusHistory={bundle.status_history}
                    />
                ) : (
                    <AiCallHistoryPane
                        leadId={leadId}
                        campaignId={bundle.latest_campaign_id}
                    />
                )}
            </div>
        </div>
    );
}
