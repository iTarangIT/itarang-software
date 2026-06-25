"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";

export function LayoutWrapper({ children }: { children: React.ReactNode }) {
    const pathname = usePathname() ?? "";
    // /nbfc/* and /risk-head/* render their own full chrome (NbfcPortalShell /
    // RiskHeadShell). Without this skip, the admin sidebar + header + ml-64
    // stack on top of that layout's sidebar + ml-64, pushing the page content
    // into a sliver on the right and duplicating the header — exactly the
    // double-chrome seen on the Risk Head Battery Monitoring page.
    if (pathname.startsWith("/nbfc") || pathname.startsWith("/risk-head")) {
        return <>{children}</>;
    }
    return (
        <div className="flex bg-[color:var(--color-bg)] min-h-screen">
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