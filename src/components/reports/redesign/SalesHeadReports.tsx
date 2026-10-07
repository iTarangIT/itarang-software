"use client";

// Sales Head › Reports — the "Reports · Analyses, data downloads, scheduled
// emails" design (docs/crm-reports-admin/CRM Reporting & Dashboards.html),
// on live data. Three tabs; the open tab is kept in ?section= so a link or a
// "Download these leads" button can open a tab directly.

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AnalysesTab } from "./AnalysesTab";
import { DownloadsTab } from "./DownloadsTab";
import { EmailsTab } from "./EmailsTab";
import { C, Segmented } from "./ui";

type Section = "analyses" | "downloads" | "emails";

const TITLES: Record<Section, [string, string]> = {
    analyses: ["What worked, and why", "Look-back analyses. Each one drives a recurring decision and has no home on a dashboard."],
    downloads: [
        "Raw data, one place",
        "Every dataset uses the same definitions as the dashboards and the daily email. Pick a dataset, set filters, choose columns, download.",
    ],
    emails: ["Emails that go out on their own", "What each automatic report holds, when it goes and who gets it."],
};

export function SalesHeadReports() {
    const params = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const asked = params.get("section");
    const section: Section = asked === "downloads" || asked === "emails" ? asked : "analyses";

    /** Switch tab, optionally carrying query params (dataset, dates) for that tab. */
    const go = useCallback(
        (next: Section, extra?: Record<string, string>) => {
            const p = new URLSearchParams(extra ?? {});
            p.set("section", next);
            router.replace(`${pathname}?${p.toString()}`, { scroll: false });
        },
        [pathname, router],
    );

    const [title, sub] = TITLES[section];

    return (
        <div className="min-h-full bg-[#f4f7fa] px-4 py-6 md:px-8 md:py-8">
            <div className="mx-auto flex max-w-[1440px] flex-col gap-[22px]">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between lg:gap-6">
                    <div className="flex flex-col gap-1.5">
                        <span className="text-[12px] font-bold tracking-[0.12em] text-[#165e73]">REPORTS</span>
                        <h1 className={`m-0 text-[26px] font-bold tracking-[-0.02em] md:text-[30px] ${C.ink}`}>{title}</h1>
                        <p className={`m-0 text-[14px] ${C.muted}`}>{sub}</p>
                    </div>
                    <Segmented<Section>
                        ariaLabel="Reports sections"
                        size="lg"
                        value={section}
                        onChange={(v) => go(v)}
                        options={[
                            { value: "analyses", label: "Analyses" },
                            { value: "downloads", label: "Data downloads" },
                            { value: "emails", label: "Scheduled email reports" },
                        ]}
                    />
                </div>

                {section === "analyses" && <AnalysesTab onDownload={(extra) => go("downloads", extra)} />}
                {section === "downloads" && <DownloadsTab />}
                {section === "emails" && <EmailsTab />}
            </div>
        </div>
    );
}
