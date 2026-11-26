"use client";

// The "i" next to a short line of text (writing standard rule 4): the screen
// keeps one line, the full rule sits here. Opens on hover or focus, and on
// tap/click so it also works on a phone; Escape or a click outside closes it.
//
// The tooltip is drawn in a portal on document.body with fixed positioning,
// kept inside the window: an "i" inside a scrolling table (overflow-x-auto)
// or a card with overflow-hidden used to have its text cut off at the box's
// edge. It opens below the "i", or above it when there is no room below, and
// shifts left near the right edge of the screen.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

const GAP = 6;
const MARGIN = 8;

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
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
    const ref = useRef<HTMLSpanElement>(null);
    const tipRef = useRef<HTMLSpanElement>(null);
    const hoverTip = useRef(false);
    const id = useId();

    const hide = useCallback(() => {
        setOpen(false);
        setPos(null);
    }, []);
    const close = useCallback(() => {
        hide();
        setPinned(false);
    }, [hide]);

    // Place the tooltip next to the "i", inside the window.
    const place = useCallback(() => {
        const anchor = ref.current?.getBoundingClientRect();
        const tip = tipRef.current;
        if (!anchor || !tip) return;
        const w = tip.offsetWidth;
        const h = tip.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left = anchor.left;
        if (left + w > vw - MARGIN) left = Math.max(MARGIN, vw - MARGIN - w);
        let top = anchor.bottom + GAP;
        if (top + h > vh - MARGIN && anchor.top - GAP - h >= MARGIN) top = anchor.top - GAP - h;
        setPos({ top, left });
    }, []);

    // Measured once the tooltip is in the page (hidden until then, so it never flashes in the wrong spot).
    useLayoutEffect(() => {
        if (!open) return;
        const raf = window.requestAnimationFrame(place);
        return () => window.cancelAnimationFrame(raf);
    }, [open, place, children]);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent | TouchEvent) => {
            const t = e.target as Node;
            if (ref.current?.contains(t) || tipRef.current?.contains(t)) return;
            close();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") close();
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("touchstart", onDown);
        document.addEventListener("keydown", onKey);
        // Follow the "i" when the page or a table around it scrolls.
        window.addEventListener("scroll", place, true);
        window.addEventListener("resize", place);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("touchstart", onDown);
            document.removeEventListener("keydown", onKey);
            window.removeEventListener("scroll", place, true);
            window.removeEventListener("resize", place);
        };
    }, [open, place, close]);

    // Moving from the "i" onto the tooltip keeps it open (it is no longer inside the span).
    const leave = () => {
        if (pinned) return;
        window.setTimeout(() => {
            if (!hoverTip.current && !ref.current?.matches(":hover")) hide();
        }, 80);
    };

    return (
        <span ref={ref} className={`relative inline-flex align-middle ${className}`} onMouseEnter={() => setOpen(true)} onMouseLeave={leave}>
            <button
                type="button"
                aria-label={label}
                aria-expanded={open}
                aria-describedby={open ? id : undefined}
                onClick={(e) => {
                    // Inside a tile that is a link, the "i" must not follow it.
                    e.preventDefault();
                    e.stopPropagation();
                    // A tap pins it open; a second tap closes it.
                    const next = !pinned;
                    setPinned(next);
                    if (next) setOpen(true);
                    else hide();
                }}
                onFocus={() => setOpen(true)}
                onBlur={() => !pinned && hide()}
                className="inline-flex h-4 w-4 items-center justify-center rounded-full text-ink-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
                <Info className="h-3.5 w-3.5" />
            </button>
            {open &&
                typeof document !== "undefined" &&
                createPortal(
                    <span
                        ref={tipRef}
                        id={id}
                        role="tooltip"
                        onMouseEnter={() => {
                            hoverTip.current = true;
                        }}
                        onMouseLeave={() => {
                            hoverTip.current = false;
                            leave();
                        }}
                        style={{ position: "fixed", top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
                        className="z-[300] block w-[min(22rem,calc(100vw-1rem))] whitespace-normal rounded-lg border border-border bg-surface px-3 py-2 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-ink shadow-card"
                    >
                        {children}
                    </span>,
                    document.body,
                )}
        </span>
    );
}
