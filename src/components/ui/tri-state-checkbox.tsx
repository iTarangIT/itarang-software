"use client";

// A checkbox that can also be "mixed" — some children on, some off.
//
// `indeterminate` is a DOM property, not an HTML attribute, so React cannot set
// it through JSX. It has to be assigned to the node after render, which is the
// whole reason this wrapper exists rather than a bare <input type="checkbox">.
//
// Kept generic and in ui/ because nothing about it is notification-specific.

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type TriState = "on" | "off" | "mixed";

export function TriStateCheckbox({
    state,
    onToggle,
    disabled,
    className,
    ariaLabel,
}: {
    state: TriState;
    /** Receives the state the user asked for: mixed always resolves to "on". */
    onToggle: (next: boolean) => void;
    disabled?: boolean;
    className?: string;
    ariaLabel?: string;
}) {
    const ref = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (ref.current) ref.current.indeterminate = state === "mixed";
    }, [state]);

    return (
        <input
            ref={ref}
            type="checkbox"
            checked={state === "on"}
            disabled={disabled}
            aria-label={ariaLabel}
            // Clicking a mixed box turns everything ON — the same convention as a
            // file manager's "select all". Turning everything off from mixed
            // would silently discard the choices already made inside it.
            onChange={() => onToggle(state !== "on")}
            className={cn(
                "h-4 w-4 shrink-0 cursor-pointer rounded border-border accent-brand-sky",
                disabled && "cursor-not-allowed opacity-50",
                className,
            )}
        />
    );
}
