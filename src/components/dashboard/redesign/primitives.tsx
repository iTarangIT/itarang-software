"use client";

// Building blocks for the CEO overview and Sales Head operations screens
// (CRM Reporting & Dashboards redesign). Presentational only — no fetching —
// and styled from the brand tokens in globals.css, so the two screens cannot
// drift apart.

import React from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export type Tone = "good" | "warn" | "bad" | "neutral";

/** ≥100 % good, 80–99 % warn, below 80 % bad — the targets RAG rule. */
export function toneForPct(pct: number | null | undefined): Tone {
    if (pct == null) return "neutral";
    if (pct >= 100) return "good";
    if (pct >= 80) return "warn";
    return "bad";
}

const PILL_TONE: Record<Tone, string> = {
    good: "bg-success-bg text-success",
    warn: "bg-warning-bg text-warning",
    bad: "bg-danger-bg text-danger",
    neutral: "bg-[#eef1f5] text-ink-muted",
};
const TEXT_TONE: Record<Tone, string> = {
    good: "text-success",
    warn: "text-warning",
    bad: "text-danger",
    neutral: "text-ink",
};
const BAR_TONE: Record<Tone, string> = {
    good: "bg-success",
    warn: "bg-[#e0a100]",
    bad: "bg-danger",
    neutral: "bg-brand-royal",
};

export const toneText = (t: Tone) => TEXT_TONE[t];

export const inr = (n: number) =>
    n >= 1e7
        ? `₹${(n / 1e7).toFixed(2)} Cr`
        : n >= 1e5
          ? `₹${(n / 1e5).toFixed(2)} L`
          : `₹${Math.round(n).toLocaleString("en-IN")}`;
export const num = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 1 });

export function DashPageHeader({
    eyebrow,
    title,
    subtitle,
    children,
}: {
    eyebrow: string;
    title: string;
    subtitle?: React.ReactNode;
    children?: React.ReactNode;
}) {
    return (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between lg:gap-6">
            {/* The controls keep their natural width at the right; the title takes
                what is left, so a long subtitle wraps instead of squeezing them. */}
            <div className="flex min-w-0 flex-col gap-1.5 lg:flex-1">
                <span className="text-xs font-bold uppercase tracking-[0.12em] text-brand-teal">{eyebrow}</span>
                <h1 className="text-[30px] font-bold leading-tight tracking-tight text-brand-navy">{title}</h1>
                {subtitle && <p className="text-sm text-ink-muted">{subtitle}</p>}
            </div>
            {children && <div className="flex flex-wrap items-center gap-3 lg:shrink-0 lg:justify-end">{children}</div>}
        </div>
    );
}

export function SegmentedControl<T extends string>({
    label,
    options,
    value,
    onChange,
    size = "md",
}: {
    label: string;
    options: ReadonlyArray<{ value: T; label: string; disabled?: boolean; title?: string }>;
    value: T;
    onChange: (v: T) => void;
    size?: "sm" | "md";
}) {
    return (
        <div role="group" aria-label={label} className="inline-flex gap-0.5 rounded-xl bg-[#e7edf3] p-[3px]">
            {options.map((o) => {
                const active = o.value === value;
                return (
                    <button
                        key={o.value}
                        type="button"
                        aria-pressed={active}
                        disabled={o.disabled}
                        title={o.title}
                        onClick={() => onChange(o.value)}
                        className={cn(
                            "rounded-[10px] text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                            size === "md" ? "min-h-10 px-4" : "min-h-9 px-3.5",
                            active ? "bg-surface text-brand-navy shadow-sm" : "text-ink-muted hover:text-brand-navy",
                        )}
                    >
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
}

export function DashCard({
    title,
    caption,
    action,
    id,
    className,
    children,
}: {
    title?: React.ReactNode;
    caption?: React.ReactNode;
    action?: React.ReactNode;
    id?: string;
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <section
            id={id}
            className={cn(
                "flex scroll-mt-24 flex-col gap-3.5 rounded-2xl border border-border bg-surface px-6 py-[22px] shadow-card",
                className,
            )}
        >
            {(title || action) && (
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex min-w-0 flex-col gap-1">
                        {title && <h2 className="text-lg font-bold text-brand-navy">{title}</h2>}
                        {caption && <span className="text-[13.5px] text-ink">{caption}</span>}
                    </div>
                    {action && <div className="min-w-0 max-w-full">{action}</div>}
                </div>
            )}
            {children}
        </section>
    );
}

export function SectionHeading({ title, note }: { title: string; note?: string }) {
    return (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-bold text-brand-navy">{title}</h2>
            {note && <span className="text-[13px] text-ink-muted">{note}</span>}
        </div>
    );
}

export function CardLink({ href, children, primary = false }: { href: string; children: React.ReactNode; primary?: boolean }) {
    return (
        <Link
            href={href}
            className={cn(
                "inline-flex min-h-10 items-center justify-center rounded-[10px] px-3 text-[13px] font-semibold transition-colors",
                primary
                    ? "bg-brand-navy text-white hover:bg-brand-800"
                    : "border border-border text-brand-navy hover:bg-bg",
            )}
        >
            {children}
        </Link>
    );
}

export function StatusPill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
    return (
        <span className={cn("inline-flex items-center rounded-full px-2 py-[3px] text-[11.5px] font-bold", PILL_TONE[tone])}>
            {children}
        </span>
    );
}

/**
 * A section or figure the CRM cannot compute yet — never a placeholder number.
 * `empty` is the other case: the source works and simply has no rows.
 */
export function NotAvailable({ reason, className, empty = false }: { reason?: string; className?: string; empty?: boolean }) {
    return (
        <div className={cn("rounded-xl border border-dashed border-border bg-[#fbfcfd] px-4 py-5 text-center", className)}>
            <p className="text-[13px] font-semibold text-ink-muted">{empty ? "Nothing to show" : "Not available yet"}</p>
            {reason && <p className="mt-0.5 text-xs text-ink-muted">{reason}</p>}
        </div>
    );
}

export function LoadingBlock({ label = "Loading…" }: { label?: string }) {
    return <div className="h-24 animate-pulse rounded-xl bg-bg" role="status" aria-label={label} />;
}

/** CEO "Needs you today" card: icon chip, big count, one line of context, a button. */
export function ActionCard({
    icon: Icon,
    tone,
    label,
    count,
    sub,
    href,
    cta,
    primary = false,
}: {
    icon: LucideIcon;
    tone: "bad" | "warn";
    label: string;
    count: string;
    sub?: string;
    href: string;
    cta: string;
    primary?: boolean;
}) {
    return (
        <div className="flex flex-col gap-2.5 rounded-2xl border border-border bg-surface p-[18px] shadow-card">
            <div className="flex items-center gap-2.5">
                <span
                    className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]",
                        tone === "bad" ? "bg-danger-bg text-danger" : "bg-warning-bg text-warning",
                    )}
                >
                    <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="text-[13px] font-semibold leading-snug text-ink">{label}</span>
            </div>
            <span className="text-[32px] font-bold leading-none tracking-tight text-brand-navy tabular-nums">{count}</span>
            {sub && <span className="text-[12.5px] leading-snug text-ink-muted">{sub}</span>}
            <div className="mt-auto flex flex-col">
                <CardLink href={href} primary={primary}>
                    {cta}
                </CardLink>
            </div>
        </div>
    );
}

const SEVERITY: Record<"now" | "soon" | "info", { dot: string; tag: string; tone: Tone }> = {
    now: { dot: "bg-danger", tag: "Past limit", tone: "bad" },
    soon: { dot: "bg-[#e0a100]", tag: "Due", tone: "warn" },
    info: { dot: "bg-[#8a96a3]", tag: "Clean-up", tone: "neutral" },
};

/** Sales Head "Needs action now" tile: the whole tile opens its list. */
export function ActionTile({
    severity,
    count,
    label,
    sub,
    href,
}: {
    severity: "now" | "soon" | "info";
    count: string;
    label: string;
    sub?: string;
    href: string;
}) {
    const s = SEVERITY[severity];
    return (
        <Link
            href={href}
            className="grid min-h-[84px] grid-cols-[12px_auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] border border-border bg-surface px-4 py-3.5 text-ink shadow-card transition-colors hover:border-brand-200"
        >
            <span className={cn("h-2.5 w-2.5 rounded-full", s.dot)} />
            <span className="min-w-[56px] text-[28px] font-bold tracking-tight text-brand-navy tabular-nums">{count}</span>
            <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13.5px] font-semibold leading-snug">{label}</span>
                {sub && <span className="text-xs leading-snug text-ink-muted">{sub}</span>}
            </span>
            <StatusPill tone={s.tone}>{s.tag}</StatusPill>
        </Link>
    );
}

export function Sparkline({ values }: { values: number[] }) {
    if (values.length < 2) return <div className="h-[30px]" />;
    const min = Math.min(...values);
    const span = Math.max(...values) - min || 1;
    const points = values
        .map((v, i) => `${(4 + (i * 104) / (values.length - 1)).toFixed(1)},${(32 - ((v - min) / span) * 28).toFixed(1)}`)
        .join(" ");
    return (
        <svg width="100%" height="30" viewBox="0 0 112 36" preserveAspectRatio="none" aria-hidden>
            <polyline
                points={points}
                fill="none"
                className="stroke-brand-royal"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
            />
        </svg>
    );
}

export function KpiTile({
    label,
    value,
    pill,
    delta,
    spark,
    sub,
    href,
}: {
    label: string;
    value: string;
    /** Makes the whole tile a link to the detail behind the number. */
    href?: string;
    pill?: { text: string; tone: Tone };
    /** `good` colours the change green, otherwise red; omit when there is no previous period. */
    delta?: { text: string; good: boolean } | null;
    spark?: number[];
    sub?: string;
}) {
    const body = (
        <>
            <span className="text-[13px] font-semibold text-ink-muted">{label}</span>
            <span className="text-[27px] font-bold leading-tight tracking-tight text-brand-navy tabular-nums">{value}</span>
            <div className="flex min-h-[22px] flex-wrap items-center gap-2">
                {pill && <StatusPill tone={pill.tone}>{pill.text}</StatusPill>}
                {delta && (
                    <span className={cn("text-[12.5px] font-semibold", delta.good ? "text-success" : "text-danger")}>{delta.text}</span>
                )}
            </div>
            {spark && spark.length > 1 ? <Sparkline values={spark} /> : null}
            {sub && <span className="text-xs leading-snug text-ink-muted">{sub}</span>}
        </>
    );
    const box = "flex flex-col gap-2 rounded-2xl border border-border bg-surface p-[18px] shadow-card";
    return href ? (
        <Link href={href} className={cn(box, "transition hover:border-brand-sky hover:shadow-md")}>
            {body}
        </Link>
    ) : (
        <div className={box}>{body}</div>
    );
}

/** A horizontal bar. `tick` draws the black 100 % mark at that position. */
export function ProgressBar({
    pct,
    tone = "neutral",
    tick,
    height = 10,
    muted = false,
}: {
    pct: number;
    tone?: Tone;
    tick?: number;
    height?: number;
    muted?: boolean;
}) {
    return (
        <div className="relative grow rounded-full bg-[#eef1f5]" style={{ height }}>
            <div
                className={cn("rounded-full", muted ? "bg-[#aab4bf]" : BAR_TONE[tone])}
                style={{ height, width: `${Math.max(0, Math.min(100, pct))}%` }}
            />
            {tick != null && <div className="absolute -top-[3px] h-4 w-0.5 bg-ink" style={{ left: `${tick}%` }} />}
        </div>
    );
}

/** One proportional strip, e.g. dealers by health bucket. */
export function StackedBand({ parts, height = 18 }: { parts: Array<{ key: string; n: number; color: string }>; height?: number }) {
    const live = parts.filter((p) => p.n > 0);
    if (live.length === 0) return <div className="rounded bg-[#eef1f5]" style={{ height }} />;
    return (
        <div className="flex gap-0.5" style={{ height }}>
            {live.map((p) => (
                <div key={p.key} className="rounded" style={{ height, flexGrow: p.n, flexBasis: 0, background: p.color }} />
            ))}
        </div>
    );
}

const HEAT_RAMP = ["#f4f7fa", "#eef3f9", "#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef"];
export const HEAT_LEGEND = HEAT_RAMP.slice(1);

export function heatColor(v: number, max: number): string {
    if (v <= 0 || max <= 0) return HEAT_RAMP[0];
    return HEAT_RAMP[Math.min(5, 1 + Math.floor((v / max) * 4.999))];
}

export function HeatCell({ value, max, href }: { value: number; max: number; href?: string }) {
    const cls = "flex min-h-[38px] items-center justify-center rounded-lg text-[13.5px] font-semibold text-ink tabular-nums";
    const style = { background: heatColor(value, max) };
    return href ? (
        <Link href={href} className={cn(cls, "hover:ring-2 hover:ring-brand-200")} style={style}>
            {num(value)}
        </Link>
    ) : (
        <span className={cls} style={style}>
            {num(value)}
        </span>
    );
}

export const TABLE_HEAD = "text-[11px] font-bold uppercase tracking-[0.06em] text-ink-muted";
