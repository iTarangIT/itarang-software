"use client";

// shadcn-style StatCard — the KPI tile for the admin dashboard. Mounts with a
// staggered rise (drive the stagger with `index`). Tone tints the icon chip
// and the value so a concerning metric draws the eye. BRD §6.B tokens.

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export type StatTone = "neutral" | "sky" | "success" | "warning" | "danger";

const TONE_CHIP: Record<StatTone, string> = {
    neutral: "bg-brand-50 text-brand-600",
    sky: "bg-info-bg text-info",
    success: "bg-success-bg text-success",
    warning: "bg-warning-bg text-warning",
    danger: "bg-danger-bg text-danger",
};

const TONE_VALUE: Record<StatTone, string> = {
    neutral: "text-brand-navy",
    sky: "text-info",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
};

type Props = {
    label: string;
    value: string | number;
    hint?: string;
    tone?: StatTone;
    icon?: React.ComponentType<{ className?: string }>;
    index?: number;
    onClick?: () => void;
};

export function StatCard({
    label,
    value,
    hint,
    tone = "neutral",
    icon: Icon,
    index = 0,
    onClick,
}: Props) {
    const clickable = !!onClick;
    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
                duration: 0.32,
                delay: index * 0.04,
                ease: [0.22, 1, 0.36, 1],
            }}
            onClick={onClick}
            className={cn(
                "relative rounded-xl border border-border bg-surface p-4 shadow-card",
                clickable &&
                    "cursor-pointer transition-shadow hover:shadow-soft",
            )}
        >
            <div className="flex items-start justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                    {label}
                </span>
                {Icon && (
                    <span
                        className={cn(
                            "flex h-7 w-7 items-center justify-center rounded-lg",
                            TONE_CHIP[tone],
                        )}
                    >
                        <Icon className="h-3.5 w-3.5" />
                    </span>
                )}
            </div>
            <div
                className={cn(
                    "mt-2 text-[1.75rem] font-semibold leading-none tabular-nums",
                    TONE_VALUE[tone],
                )}
            >
                {value}
            </div>
            {hint && (
                <div className="mt-1.5 text-[10px] leading-snug text-ink-muted">
                    {hint}
                </div>
            )}
        </motion.div>
    );
}
