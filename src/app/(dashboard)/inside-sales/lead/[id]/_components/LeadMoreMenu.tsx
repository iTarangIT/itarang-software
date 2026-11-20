"use client";

// ID 246 — the action bar's "More" menu: the lead page's secondary actions,
// each with the same handler, the same show/hide rule and the same disabled
// reason it had as a button (244_246 workflows, section 2).

import { useEffect, useRef, useState } from "react";
import { ChevronDown, MoreHorizontal } from "lucide-react";

export type MoreMenuItem = {
    key: string;
    label: string;
    icon?: React.ComponentType<{ className?: string }>;
    onClick: () => void;
    disabled?: boolean;
    /** Shown under a disabled item (and as its tooltip). */
    disabledReason?: string;
    /** A short explanation under the label — the "i" text the button had (ID 215: never deleted). */
    hint?: string;
    tone?: "gray" | "rose" | "amber" | "emerald";
};

export function LeadMoreMenu({ items }: { items: MoreMenuItem[] }) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    if (!items.length) return null;
    const tones: Record<string, string> = {
        gray: "text-gray-800",
        rose: "text-rose-700",
        amber: "text-amber-700",
        emerald: "text-emerald-700",
    };

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold bg-white border border-gray-200 text-gray-700 hover:bg-gray-50"
            >
                <MoreHorizontal className="h-3.5 w-3.5" />
                More
                <ChevronDown className={`h-3 w-3 transition ${open ? "rotate-180" : ""}`} />
            </button>
            {open && (
                <div
                    role="menu"
                    className="absolute right-0 bottom-full mb-2 z-30 w-60 rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
                >
                    {items.map((it) => {
                        const Icon = it.icon;
                        return (
                            <button
                                key={it.key}
                                type="button"
                                role="menuitem"
                                disabled={it.disabled}
                                title={it.disabled ? it.disabledReason : undefined}
                                onClick={() => {
                                    setOpen(false);
                                    it.onClick();
                                }}
                                className={`w-full text-left px-3 py-2 text-xs font-medium hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 ${tones[it.tone ?? "gray"]}`}
                            >
                                <span className="inline-flex items-center gap-2">
                                    {Icon && <Icon className="h-3.5 w-3.5" />}
                                    {it.label}
                                </span>
                                {it.disabled && it.disabledReason ? (
                                    <span className="block pl-5 text-[11px] font-normal text-gray-500">{it.disabledReason}</span>
                                ) : it.hint ? (
                                    <span className="block pl-5 text-[11px] font-normal text-gray-500">{it.hint}</span>
                                ) : null}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
