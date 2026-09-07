"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Tabs } from "@/components/ui/tabs";
import { NotificationAccessManager } from "./NotificationAccessManager";
import { EmailNotificationManager } from "./EmailNotificationManager";

// Two sections, two channels: Notification Access (E-231) governs the in-app
// bell, Email Notification (E-282) governs the email emit() sends. They belong
// on one page because they are the same decision asked twice, and an admin who
// mutes a bell row almost always wants to know what the email is doing.
//
// The tab strip lived here before and was removed when this page was down to a
// single section — a one-item tab bar is dead chrome. It is back for the same
// reason it went away.
//
// KYC Automation (E-246) is NOT one of these tabs: it has its own route at
// /admin/settings/kyc-automation and its own sidebar entry. Assignment Config,
// Holiday Calendar and ASM Territories were removed from the strip on request;
// their components (AssignmentConfigForm, HolidayCalendarManager,
// TerritoryManager) and the /api/admin/settings bundle they read are still in
// place and untouched, so restoring one is re-adding it here rather than
// rebuilding the feature. That bundle's `useQuery` is deliberately NOT restored
// — only those three tabs ever consumed it, and neither tab below needs it.

const TAB_VALUES = ["access", "email"] as const;
type TabValue = (typeof TAB_VALUES)[number];

export function SettingsView() {
    const router = useRouter();
    const searchParams = useSearchParams();

    const param = searchParams.get("tab");
    const active: TabValue = TAB_VALUES.includes(param as TabValue)
        ? (param as TabValue)
        : "access";

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
                    { value: "access", label: "Notification Access" },
                    { value: "email", label: "Email Notification" },
                ]}
            />

            <div className="rounded-xl border border-border bg-surface shadow-card">
                <div className="p-5">
                    {active === "access" && <NotificationAccessManager />}
                    {active === "email" && <EmailNotificationManager />}
                </div>
            </div>
        </div>
    );
}
