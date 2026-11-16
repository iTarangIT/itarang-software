"use client";

// ID 232: records every page this tab visits (path + query) so a lead page's
// Back can return to the exact list, tab and filters the person came from.
// A new tab starts with an empty stack, so its Back goes to the home queue.

import { Suspense, useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { pushVisit, readNavStack, writeNavStack } from "@/lib/nav/backTarget";

function Tracker() {
    const pathname = usePathname() ?? "";
    const search = useSearchParams()?.toString() ?? "";
    useEffect(() => {
        if (!pathname) return;
        writeNavStack(pushVisit(readNavStack(), search ? `${pathname}?${search}` : pathname));
    }, [pathname, search]);
    return null;
}

export function NavHistoryTracker() {
    return (
        <Suspense fallback={null}>
            <Tracker />
        </Suspense>
    );
}
