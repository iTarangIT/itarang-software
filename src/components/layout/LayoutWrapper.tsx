"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";

export function LayoutWrapper({ children }: { children: React.ReactNode }) {
    const pathname = usePathname() ?? "";
    // /nbfc/* renders its own full chrome (NbfcPortalSidebar). Without this
    // skip, the admin sidebar + header + ml-64 stack on top of the NBFC
    // layout's sidebar + ml-64, pushing the page content into a sliver on
    // the right and breaking responsive layout at narrow viewports.
    if (pathname.startsWith("/nbfc")) {
        return <>{children}</>;
    }
    return (
        <div className="flex bg-[color:var(--color-bg)] min-h-screen">
            <Sidebar />
            <div className="flex-1 md:ml-64 flex flex-col min-h-screen">
                <Header />
                <main className="flex-1 p-6 md:p-8 overflow-y-auto">
                    <div className="max-w-7xl mx-auto">{children}</div>
                </main>
            </div>
        </div>
    );
}