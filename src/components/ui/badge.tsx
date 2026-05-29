// shadcn-style Badge — iTarang brand tokens (BRD §6.B). Used for every status
// chip across the admin workspace so semantics read consistently.

import { cn } from "@/lib/utils";

export type BadgeVariant =
    | "default"
    | "navy"
    | "sky"
    | "success"
    | "warning"
    | "danger"
    | "info"
    | "outline"
    | "muted";

const VARIANTS: Record<BadgeVariant, string> = {
    default: "bg-brand-50 text-brand-700 border-brand-100",
    navy: "bg-brand-navy text-white border-transparent",
    sky: "bg-brand-sky text-white border-transparent",
    success: "bg-success-bg text-success border-transparent",
    warning: "bg-warning-bg text-warning border-transparent",
    danger: "bg-danger-bg text-danger border-transparent",
    info: "bg-info-bg text-info border-transparent",
    outline: "bg-surface text-ink-muted border-border",
    muted: "bg-bg text-ink-muted border-border",
};

type Props = React.HTMLAttributes<HTMLSpanElement> & {
    variant?: BadgeVariant;
    uppercase?: boolean;
};

export function Badge({
    variant = "default",
    uppercase,
    className,
    ...props
}: Props) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold leading-tight",
                uppercase && "uppercase tracking-wide text-[10px]",
                VARIANTS[variant],
                className,
            )}
            {...props}
        />
    );
}
