"use client";

// The "i" next to a short line of text (writing standard rule 4): the screen
// keeps one line, the full rule sits here. Opens on hover or focus, and on
// tap/click so it also works on a phone; Escape or a click outside closes it.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";

export function InfoTip({
    children,
    label = "More about this",
    className = "",
}: {
    children: ReactNode;
    /** Screen-reader name of the "i" button. */
    label?: string;
    className?: string;
}) {
    const [open, setOpen] = useState(false);
    const [pinned, setPinned] = useState(false);
    const ref = useRef<HTMLSpanElement>(null);
    const id = useId();

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent | TouchEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
                setPinned(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setOpen(false);
                setPinned(false);
            }
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("touchstart", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("touchstart", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    return (
        <span
            ref={ref}
            className={`relative inline-flex align-middle ${className}`}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => !pinned && setOpen(false)}
        >
            <button
                type="button"
                aria-label={label}
                aria-expanded={open}
                aria-describedby={open ? id : undefined}
                onClick={() => {
                    // A tap pins it open; a second tap closes it.
                    const next = !pinned;
                    setPinned(next);
                    setOpen(next);
                }}
                onFocus={() => setOpen(true)}
                onBlur={() => !pinned && setOpen(false)}
                className="inline-flex h-4 w-4 items-center justify-center rounded-full text-ink-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
                <Info className="h-3.5 w-3.5" />
            </button>
            {open && (
                <span
                    id={id}
                    role="tooltip"
                    className="absolute left-0 top-full z-50 mt-1.5 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface px-3 py-2 text-xs font-normal leading-relaxed text-ink shadow-card"
                >
                    {children}
                </span>
            )}
        </span>
    );
}
