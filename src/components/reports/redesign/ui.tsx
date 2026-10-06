"use client";

// Small building blocks for the Sales Head Reports page, in the colours of the
// "Reports · Analyses, data downloads, scheduled emails" design board. They are
// local to this page on purpose: the global theme is not touched.

import type { ReactNode } from "react";
import { Check, X } from "lucide-react";

export const C = {
    ink: "text-[#02314e]",
    text: "text-[#1a2733]",
    muted: "text-[#5a6877]",
    accent: "text-[#138fc6]",
    teal: "text-[#165e73]",
} as const;

export const CARD =
    "rounded-2xl border border-[#e3e8ef] bg-white shadow-[0_1px_3px_rgba(2,49,78,0.06),0_1px_2px_rgba(2,49,78,0.08)]";
export const PANEL = "rounded-2xl border border-[#e3e8ef] bg-white";
export const EYEBROW = "text-[12px] font-bold tracking-[0.08em] text-[#5a6877]";
export const TH = "text-[11px] font-bold tracking-[0.05em] text-[#5a6877] uppercase";
export const BTN_OUTLINE =
    "inline-flex min-h-[44px] items-center gap-2 rounded-[10px] border border-[#b8d4e6] bg-white px-4 text-[13.5px] font-semibold text-[#02314e] transition hover:bg-[#f4f7fa] disabled:cursor-not-allowed disabled:opacity-50";
export const BTN_SOLID =
    "inline-flex min-h-[44px] items-center gap-2 rounded-[10px] bg-[#02314e] px-[18px] text-[13.5px] font-semibold text-white transition hover:bg-[#03466f] disabled:cursor-not-allowed disabled:opacity-50";
export const BTN_SMALL =
    "inline-flex min-h-[38px] items-center gap-1.5 rounded-[10px] border border-[#e3e8ef] bg-white px-3 text-[12.5px] font-semibold text-[#02314e] transition hover:bg-[#f4f7fa] disabled:cursor-not-allowed disabled:opacity-50";
export const PILL =
    "flex min-h-[40px] items-center gap-2 rounded-[10px] border border-[#d5dde6] bg-white px-3 text-[13px] text-[#1a2733]";
export const SELECT =
    "min-h-[40px] rounded-[10px] border border-[#d5dde6] bg-white px-2.5 text-[13px] text-[#1a2733] focus:outline-none focus:ring-2 focus:ring-[#138fc6]/40";

/** The grey track of segmented buttons the design uses for tabs and toggles. */
export function Segmented<T extends string>({
    options,
    value,
    onChange,
    size = "md",
    ariaLabel,
}: {
    options: { value: T; label: string }[];
    value: T;
    onChange: (v: T) => void;
    size?: "md" | "lg";
    ariaLabel: string;
}) {
    return (
        <div
            role="tablist"
            aria-label={ariaLabel}
            className={`flex flex-wrap gap-0.5 bg-[#e7edf3] p-[3px] ${size === "lg" ? "rounded-xl" : "rounded-[10px]"}`}
        >
            {options.map((o) => {
                const on = o.value === value;
                return (
                    <button
                        key={o.value}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        onClick={() => onChange(o.value)}
                        className={`font-semibold transition ${
                            size === "lg" ? "min-h-[42px] rounded-[10px] px-[18px] text-[13.5px]" : "min-h-[36px] rounded-lg px-3 text-[13px]"
                        } ${on ? "bg-white text-[#02314e] shadow-sm" : "bg-transparent text-[#5a6877] hover:text-[#02314e]"}`}
                    >
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
}

/** A green "Holds" / red "Breaks" self-check, as on the design. */
export function CheckPill({ label, holds, detail }: { label: string; holds: boolean; detail: string }) {
    return (
        <span
            title={detail || undefined}
            className={`flex min-h-[36px] items-center gap-2 rounded-[10px] px-3 py-1.5 text-[13px] ${C.text} ${
                holds ? "bg-[#edf7ef]" : "bg-[#fdecec]"
            }`}
        >
            {holds ? (
                <Check className="h-4 w-4 shrink-0 text-[#1e7e34]" strokeWidth={2.5} aria-hidden />
            ) : (
                <X className="h-4 w-4 shrink-0 text-[#b42318]" strokeWidth={2.5} aria-hidden />
            )}
            <span>{label}</span>
            <span className={`font-bold ${holds ? "text-[#1e7e34]" : "text-[#b42318]"}`}>{holds ? "Holds" : "Breaks"}</span>
            {!holds && detail && <span className="text-[12px] text-[#b42318]">{detail}</span>}
        </span>
    );
}

/** A labelled rule line with a green tick, for the explanatory footer panels. */
export function RuleLine({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="grid grid-cols-[18px_minmax(0,1fr)] gap-2 text-[13px] leading-[1.5]">
            <Check className="mt-0.5 h-4 w-4 text-[#1e7e34]" strokeWidth={2.5} aria-hidden />
            <span>
                <span className="font-bold">{title}</span> {children}
            </span>
        </div>
    );
}

export function Bar({ width, color }: { width: number; color: string }) {
    return (
        <span className="flex h-1.5 overflow-hidden rounded-full bg-[#eef2f6]">
            <span className="rounded-full" style={{ width: `${width}%`, background: color }} />
        </span>
    );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
    return <div className={`py-10 text-center text-[13px] ${C.muted}`}>{label}</div>;
}

export function ErrorLine({ message }: { message: string }) {
    return <div className="rounded-[10px] bg-[#fdecec] px-3 py-2 text-[13px] text-[#b42318]">{message}</div>;
}

export async function getJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { cache: "no-store" });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? "Request failed");
    return json.data as T;
}
