"use client";

// ID 232: one '← Back' — the previous page in this tab with its tab and
// filters, or the person's own home queue when there is none (new tab, link
// from outside). Who can open which page does not change.

import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { previousPage, readNavStack } from "@/lib/nav/backTarget";

export function BackToPrevious({
    homeHref,
    className,
    iconClassName = "h-3 w-3",
    label = "Back",
    onBack,
}: {
    homeHref: string;
    /** Handle Back inside the page first (e.g. undo the last filter); true = handled. */
    onBack?: () => boolean;
    className?: string;
    iconClassName?: string;
    label?: string;
}) {
    const router = useRouter();
    const pathname = usePathname() ?? "";
    return (
        <a
            href={homeHref}
            className={className}
            onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                if (onBack?.()) return;
                router.push(previousPage(readNavStack(), pathname) ?? homeHref);
            }}
        >
            <ArrowLeft className={iconClassName} />
            {label}
        </a>
    );
}
