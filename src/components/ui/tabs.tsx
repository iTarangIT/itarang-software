"use client";

// shadcn-style Tabs — a lightweight controlled tab strip with a motion-driven
// active underline in brand sky. No Radix dependency; matches BRD §6.B.

import { useId } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export type TabItem = {
    value: string;
    label: string;
    count?: number | null;
};

export function Tabs({
    tabs,
    value,
    onValueChange,
    className,
}: {
    tabs: TabItem[];
    value: string;
    onValueChange: (value: string) => void;
    className?: string;
}) {
    const groupId = useId();

    return (
        <div
            className={cn(
                "flex items-center gap-1 border-b border-border",
                className,
            )}
            role="tablist"
        >
            {tabs.map((t) => {
                const active = t.value === value;
                return (
                    <button
                        key={t.value}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => onValueChange(t.value)}
                        className={cn(
                            "relative px-4 py-2.5 text-sm font-medium transition-colors",
                            active
                                ? "text-brand-navy"
                                : "text-ink-muted hover:text-ink",
                        )}
                    >
                        <span className="inline-flex items-center gap-1.5">
                            {t.label}
                            {t.count != null && (
                                <span
                                    className={cn(
                                        "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                                        active
                                            ? "bg-brand-100 text-brand-700"
                                            : "bg-bg text-ink-muted",
                                    )}
                                >
                                    {t.count}
                                </span>
                            )}
                        </span>
                        {active && (
                            <motion.span
                                layoutId={`tab-underline-${groupId}`}
                                className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand-sky"
                                transition={{
                                    type: "spring",
                                    stiffness: 480,
                                    damping: 38,
                                }}
                            />
                        )}
                    </button>
                );
            })}
        </div>
    );
}
