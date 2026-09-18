"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

import { Tabs } from "@/components/ui/tabs";
import { NotificationAccessManager } from "./NotificationAccessManager";
import { EmailNotificationManager } from "./EmailNotificationManager";
import { QuotationCcForm } from "./QuotationCcForm";
import { TerritoryManager } from "./TerritoryManager";
import type { SettingsBundle } from "@/lib/admin/types";

// Two sections, two channels: Notification Access (E-231) governs the in-app
// bell, Email Notification (E-284) governs the email emit() sends. They belong
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
// place, so restoring one is re-adding it here rather than rebuilding.
//
// ASM Territories IS back (B3, 2026-09-18): the ASM queue's "Unclaimed in my
// territory" tab and its bulk claim are scoped by asm_territories, and there was
// no screen left in the product to fill that table. The bundle `useQuery` is
// restored for this tab alone and only fires while it is the active tab.

// Quotation CC (E-297) sits here too: it is also "who gets which email".
const TAB_VALUES = ["access", "email", "quotation-cc", "territories"] as const;
type TabValue = (typeof TAB_VALUES)[number];

export function SettingsView() {
    const router = useRouter();
    const searchParams = useSearchParams();

    const param = searchParams.get("tab");
    const active: TabValue = TAB_VALUES.includes(param as TabValue)
        ? (param as TabValue)
        : "access";

    // Fetched only on the Territories tab — the other three never read it.
    // Key must stay ["admin-settings"]: TerritoryManager invalidates that after
    // every add / remove.
    const bundleQuery = useQuery<{ success: true; data: SettingsBundle }>({
        queryKey: ["admin-settings"],
        queryFn: async () => {
            const res = await fetch("/api/admin/settings", { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load settings");
            return res.json();
        },
        enabled: active === "territories",
    });

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
                    { value: "quotation-cc", label: "Quotation CC" },
                    { value: "territories", label: "ASM Territories" },
                ]}
            />

            <div className="rounded-xl border border-border bg-surface shadow-card">
                <div className="p-5">
                    {active === "access" && <NotificationAccessManager />}
                    {active === "email" && <EmailNotificationManager />}
                    {active === "quotation-cc" && <QuotationCcForm />}
                    {active === "territories" &&
                        (bundleQuery.isLoading ? (
                            <div className="flex items-center gap-2 py-8 text-sm text-ink-muted">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Loading territories…
                            </div>
                        ) : bundleQuery.error ? (
                            <p className="py-8 text-sm text-danger">
                                {(bundleQuery.error as Error).message}
                            </p>
                        ) : (
                            <TerritoryManager
                                territories={bundleQuery.data?.data.territories ?? []}
                            />
                        ))}
                </div>
            </div>
        </div>
    );
}
