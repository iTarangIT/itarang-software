"use client";

// One "⋯" actions menu (wording audit C12 / C28, 2 Nov): rarely used row or
// page actions sit here instead of stacked text links or extra buttons.
// Closes on a click outside, Escape, or after an item is chosen.

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";

export type ActionsMenuItem = {
    label: string;
    onSelect: () => void;
    tone?: "default" | "danger" | "good";
    disabled?: boolean;
    title?: string;
};

export function ActionsMenu({
    items,
    label = "More actions",
    align = "right",
    buttonClassName = "",
}: {
    items: ActionsMenuItem[];
    /** Screen-reader name of the "⋯" button. */
    label?: string;
    align?: "left" | "right";
    buttonClassName?: string;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    if (items.length === 0) return null;

    return (
        <div ref={ref} className="relative inline-block text-left">
            <button
                type="button"
                aria-label={label}
                title={label}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 hover:text-gray-900 ${buttonClassName}`}
            >
                <MoreHorizontal className="h-4 w-4" />
            </button>
            {open && (
                <div
                    role="menu"
                    className={`absolute ${align === "right" ? "right-0" : "left-0"} z-30 mt-1 min-w-[12rem] rounded-xl border border-gray-200 bg-white p-1 shadow-xl`}
                >
                    {items.map((it) => (
                        <button
                            key={it.label}
                            type="button"
                            role="menuitem"
                            disabled={it.disabled}
                            title={it.title}
                            onClick={() => {
                                setOpen(false);
                                it.onSelect();
                            }}
                            className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm hover:bg-gray-50 disabled:opacity-50 ${
                                it.tone === "danger" ? "text-rose-700" : it.tone === "good" ? "text-emerald-700" : "text-gray-700"
                            }`}
                        >
                            {it.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
