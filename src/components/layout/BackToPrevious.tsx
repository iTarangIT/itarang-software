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
}: {
    homeHref: string;
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
                router.push(previousPage(readNavStack(), pathname) ?? homeHref);
            }}
        >
            <ArrowLeft className={iconClassName} />
            {label}
        </a>
    );
}
