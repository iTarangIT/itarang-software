"use client";

// Layout primitives for the Ecofy workspace tabs (E-307). Plain Tailwind, same
// palette as the rest of the CRM's server-rendered pages.

import type { ReactNode } from "react";

export function Panel({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
    return (
        <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
                <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
                {right ? <div className="text-xs text-gray-500">{right}</div> : null}
            </header>
            <div className="p-4">{children}</div>
        </section>
    );
}

export function FormBox({ children, onSubmit }: { children: ReactNode; onSubmit?: (e: React.FormEvent) => void }) {
    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                onSubmit?.(e);
            }}
            className="mb-4 grid grid-cols-1 gap-3 rounded-lg bg-gray-50 p-3 sm:grid-cols-2"
        >
            {children}
        </form>
    );
}

export function Field({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
    return (
        <label className={`flex flex-col gap-1 text-xs font-medium text-gray-600 ${wide ? "sm:col-span-2" : ""}`}>
            {label}
            {children}
            {hint ? <span className="font-normal text-gray-400">{hint}</span> : null}
        </label>
    );
}

export const inputCls =
    "w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 disabled:bg-gray-100";

const DEFAULT_TIME = "10:00";

/**
 * Date + time as two native inputs, held as ONE `YYYY-MM-DDTHH:mm` string (the
 * same shape the forms already send through `localToIso`).
 *
 * Why not `<input type="datetime-local">`: picking a date from its calendar
 * leaves the time segment empty, so the input's value stays "" and the Book /
 * Log buttons silently stay disabled — the "can't select a date and time"
 * report. Here choosing a date fills a default time at once, the time is
 * changed freely, and the line below says exactly what will be saved. No
 * min / max: any date and time may be chosen.
 */
export function DateTimeField({
    label,
    value,
    onChange,
    required,
    hint,
    wide,
}: {
    label: string;
    value: string;
    onChange: (next: string) => void;
    required?: boolean;
    hint?: string;
    wide?: boolean;
}) {
    const [date, time] = value ? value.split("T") : ["", ""];
    const preview = value ? formatIstPreview(value) : null;
    return (
        <div className={`flex flex-col gap-1 text-xs font-medium text-gray-600 ${wide ? "sm:col-span-2" : ""}`}>
            <span>{label}</span>
            <div className="grid grid-cols-[1fr_auto] gap-2">
                <input
                    type="date"
                    className={inputCls}
                    value={date}
                    required={required}
                    aria-label={`${label} — date`}
                    onChange={(e) => onChange(e.target.value ? `${e.target.value}T${time || DEFAULT_TIME}` : "")}
                />
                <input
                    type="time"
                    className={`${inputCls} w-28`}
                    value={time}
                    required={required}
                    aria-label={`${label} — time`}
                    onChange={(e) => onChange(date ? `${date}T${e.target.value || DEFAULT_TIME}` : "")}
                />
            </div>
            <span className="font-normal text-gray-400">
                {preview ? `Will be saved as ${preview} (IST)` : hint ?? "Pick a date; the time fills in and can be changed."}
            </span>
        </div>
    );
}

/** "Tue, 29 Sept 2026, 10:00 am" for a `YYYY-MM-DDTHH:mm` value typed as IST. */
function formatIstPreview(v: string): string | null {
    const d = new Date(`${v}:00+05:30`);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Native file input with a proper "Choose file" button (Tailwind `file:` variants). */
export const fileInputCls =
    "block w-full cursor-pointer rounded-md border border-gray-300 bg-white text-sm text-gray-700 file:mr-3 file:cursor-pointer file:rounded-l-md file:border-0 file:border-r file:border-gray-300 file:bg-gray-900 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:file:cursor-not-allowed";

export function Btn({
    children,
    onClick,
    disabled,
    type = "button",
    variant = "default",
}: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: "button" | "submit";
    variant?: "default" | "primary" | "danger" | "success";
}) {
    const tone = {
        default: "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50",
        primary: "bg-gray-900 text-white hover:bg-gray-800",
        danger: "bg-red-600 text-white hover:bg-red-700",
        success: "bg-emerald-600 text-white hover:bg-emerald-700",
    }[variant];
    return (
        <button
            type={type}
            onClick={onClick}
            disabled={disabled}
            className={`inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${tone}`}
        >
            {children}
        </button>
    );
}

export function Empty({ children }: { children: ReactNode }) {
    return <p className="rounded-lg border border-dashed border-gray-200 p-4 text-center text-sm text-gray-500">{children}</p>;
}

export function Chip({ children, tone = "gray" }: { children: ReactNode; tone?: "gray" | "sky" | "green" | "amber" | "red" | "dark" }) {
    const cls = {
        gray: "bg-gray-100 text-gray-700",
        sky: "bg-sky-50 text-sky-700",
        green: "bg-emerald-50 text-emerald-700",
        amber: "bg-amber-50 text-amber-800",
        red: "bg-red-50 text-red-700",
        dark: "bg-gray-900 text-white",
    }[tone];
    return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

export function KV({ rows }: { rows: Array<[string, ReactNode]> }) {
    return (
        <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1.5 text-sm">
            {rows.map(([k, v]) => (
                <div key={k} className="contents">
                    <dt className="text-gray-500">{k}</dt>
                    <dd className="break-words text-gray-900">{v === null || v === undefined || v === "" ? "—" : v}</dd>
                </div>
            ))}
        </dl>
    );
}

export function Loading() {
    return <p className="text-sm text-gray-500">Loading from Ecofy…</p>;
}

export function ErrorNote({ error }: { error: unknown }) {
    return (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error instanceof Error ? error.message : "Could not load from Ecofy"}
        </p>
    );
}
