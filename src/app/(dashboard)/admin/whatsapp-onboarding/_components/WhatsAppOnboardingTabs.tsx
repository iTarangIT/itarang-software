"use client";

import { useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Tabs } from "@/components/ui/tabs";
import { LiveConversationsView } from "./LiveConversationsView";
import { CustomerLeadsView } from "./CustomerLeadsView";
import { WhatsAppOperatorsView } from "./WhatsAppOperatorsView";
import type { ConversationSummary } from "./types";

const TAB_VALUES = ["live", "leads", "team"] as const;
type TabValue = (typeof TAB_VALUES)[number];

export function WhatsAppOnboardingTabs({ viewerRole }: { viewerRole: string }) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [summary, setSummary] = useState<ConversationSummary | null>(null);

    const param = searchParams.get("tab");
    const active: TabValue = TAB_VALUES.includes(param as TabValue)
        ? (param as TabValue)
        : "live";

    const setTab = useCallback(
        (value: string) => {
            const next = new URLSearchParams(searchParams.toString());
            next.set("tab", value);
            router.replace(`?${next.toString()}`, { scroll: false });
        },
        [router, searchParams],
    );

    return (
        <div className="space-y-4">
            <Tabs
                value={active}
                onValueChange={setTab}
                tabs={[
                    {
                        value: "live",
                        label: "Live conversations",
                        count: summary?.total ?? null,
                    },
                    { value: "leads", label: "Customer leads" },
                    { value: "team", label: "Onboarding team" },
                ]}
            />

            {active === "live" && (
                <LiveConversationsView onSummary={setSummary} />
            )}
            {active === "leads" && <CustomerLeadsView />}
            {active === "team" && (
                <WhatsAppOperatorsView viewerRole={viewerRole} />
            )}
        </div>
    );
}
