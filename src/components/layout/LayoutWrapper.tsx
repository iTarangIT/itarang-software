"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { UsageHeartbeat } from "@/components/usage/UsageHeartbeat";

export function LayoutWrapper({ children }: { children: React.ReactNode }) {
    const pathname = usePathname() ?? "";
    // /nbfc/* and /risk-head/* render their own full chrome (NbfcPortalShell /
    // RiskHeadShell). Without this skip, the admin sidebar + header + ml-64
    // stack on top of that layout's sidebar + ml-64, pushing the page content
    // into a sliver on the right and duplicating the header — exactly the
    // double-chrome seen on the Risk Head Battery Monitoring page.
    //
    // <UsageHeartbeat /> is mounted in BOTH branches on purpose. This component
    // is the only one rendered on every dashboard route, and these two routes
    // are the ones that skip the sidebar and header — so mounting the heartbeat
    // anywhere else would leave exactly the modules we most want measured
    // unmeasured. It renders null, so it cannot affect either layout.
    if (pathname.startsWith("/nbfc") || pathname.startsWith("/risk-head")) {
        return (
            <>
                <UsageHeartbeat />
                {children}
            </>
        );
    }
    return (
        <div className="flex bg-[color:var(--color-bg)] min-h-screen">
            <UsageHeartbeat />
            <Sidebar />
            <div className="flex-1 min-w-0 md:ml-64 flex flex-col min-h-screen">
                <Header />
                <main className="flex-1 p-6 md:p-8">
                    <div className="max-w-7xl mx-auto min-w-0">{children}</div>
                </main>
            </div>
        </div>
    );
}