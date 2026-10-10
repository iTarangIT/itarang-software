"use client";

// A Data downloads filter of type "multiselect" (tracker ID 34 — Lead events
// › Event type). Nothing ticked means "all"; the value travels as one param of
// comma-joined option values, e.g. event_type=call,visit.

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { splitMulti, type DatasetFilter } from "@/lib/exports/datasets/types";

export function MultiSelectFilter({
    filter,
    value,
    onChange,
    className = "",
}: {
    filter: DatasetFilter;
    value: string | undefined;
    onChange: (next: string) => void;
    className?: string;
}) {
    const [open, setOpen] = useState(false);
    const box = useRef<HTMLDivElement>(null);
    const options = filter.options ?? [];
    const picked = new Set(splitMulti(value));
    const count = options.filter((o) => picked.has(o.value)).length;

    useEffect(() => {
        if (!open) return;
        const close = (e: MouseEvent) => {
            if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
        };
        const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
        document.addEventListener("mousedown", close);
        document.addEventListener("keydown", esc);
        return () => {
            document.removeEventListener("mousedown", close);
            document.removeEventListener("keydown", esc);
        };
    }, [open]);

    const toggle = (v: string) => {
        const next = new Set(picked);
        if (next.has(v)) next.delete(v);
        else next.add(v);
        // Keep the catalogue's order; every option ticked is the same as none.
        const list = options.map((o) => o.value).filter((o) => next.has(o));
        onChange(list.length === options.length ? "" : list.join(","));
    };

    const summary =
        count === 0
            ? "All"
            : count === 1
              ? (options.find((o) => picked.has(o.value))?.label ?? "1 picked")
              : `${count} picked`;

    return (
        <div ref={box} className="relative">
            <button
                type="button"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={filter.label}
                onClick={() => setOpen((o) => !o)}
                className={`flex items-center gap-1.5 ${className}`}
            >
                <span className="truncate">
                    {filter.label}: {summary}
                </span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
            </button>
            {open && (
                <div
                    role="listbox"
                    aria-multiselectable="true"
                    className="absolute left-0 z-30 mt-1 max-h-[320px] w-[260px] overflow-y-auto rounded-lg border border-[#d5dde6] bg-white p-1.5 shadow-lg"
                >
                    <button
                        type="button"
                        onClick={() => onChange("")}
                        className="mb-1 w-full rounded px-2 py-1 text-left text-[12px] font-semibold text-[#138fc6] hover:bg-[#f4f7fa]"
                    >
                        All {filter.label.toLowerCase()}s
                    </button>
                    {options.map((o) => (
                        <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[13px] text-[#1a2733] hover:bg-[#f4f7fa]">
                            <input
                                type="checkbox"
                                checked={picked.has(o.value)}
                                onChange={() => toggle(o.value)}
                                className="accent-[#02314e]"
                            />
                            {o.label}
                        </label>
                    ))}
                </div>
            )}
        </div>
    );
}
