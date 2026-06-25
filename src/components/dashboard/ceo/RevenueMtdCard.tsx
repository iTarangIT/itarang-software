"use client";

import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
    DollarSign,
    SlidersHorizontal,
    ArrowUpRight,
    ArrowDownRight,
    Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatINRCompact, formatINRExact } from "@/lib/format";

type Period = "mtd" | "fy";

interface RevenueMtdCardProps {
    /** Month-to-date revenue, excluding void & draft (the default figure). */
    base: number;
    /** Sum of void invoices this month. */
    voidAmount: number;
    /** Sum of draft invoices this month. */
    draftAmount: number;
    /** Financial-year-to-date revenue (since 1 Apr), excluding void & draft. */
    fyBase: number;
    /** Sum of void invoices this financial year. */
    fyVoidAmount: number;
    /** Sum of draft invoices this financial year. */
    fyDraftAmount: number;
    /** Label for the FY start, e.g. "1 Apr 2026". */
    fyStartLabel?: string;
    /** Month-over-month change in percent (MTD only). Omit/null to hide. */
    change?: number | null;
}

const formatLakhs = (v: number) => formatINRCompact(v);

export function RevenueMtdCard({
    base,
    voidAmount,
    draftAmount,
    fyBase,
    fyVoidAmount,
    fyDraftAmount,
    fyStartLabel,
    change,
}: RevenueMtdCardProps) {
    const [open, setOpen] = useState(false);
    const [period, setPeriod] = useState<Period>("mtd");
    const [includeVoid, setIncludeVoid] = useState(false);
    const [includeDraft, setIncludeDraft] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Close the popover on outside-click and Escape.
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (e: MouseEvent) => {
            if (
                containerRef.current &&
                !containerRef.current.contains(e.target as Node)
            ) {
                setOpen(false);
            }
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("mousedown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);

    const isFy = period === "fy";
    const activeBase = isFy ? fyBase : base;
    const activeVoid = isFy ? fyVoidAmount : voidAmount;
    const activeDraft = isFy ? fyDraftAmount : draftAmount;

    const displayed =
        activeBase +
        (includeVoid ? activeVoid : 0) +
        (includeDraft ? activeDraft : 0);
    const filtersActive = includeVoid || includeDraft;
    const nonDefault = filtersActive || isFy;
    const activeLabels = [
        includeVoid ? "void" : null,
        includeDraft ? "draft" : null,
    ].filter(Boolean);

    // MoM change only applies to the month-to-date figure.
    const hasChange = !isFy && typeof change === "number" && isFinite(change);
    const isPositive = (change ?? 0) >= 0;

    return (
        <div
            ref={containerRef}
            data-testid="revenue-mtd-card"
            className={cn(
                "relative p-6 rounded-2xl bg-white/80 backdrop-blur-sm border border-gray-100 shadow-sm transition-all duration-300 hover:shadow-md hover:border-brand-100 group",
                open && "z-40",
            )}
        >
            <div className="flex items-start justify-between">
                <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-500 mb-1">
                        {isFy ? "Revenue (FYTD)" : "Revenue (MTD)"}
                    </p>
                    <h3 className="text-3xl font-bold text-gray-900 tracking-tight">
                        {formatLakhs(displayed)}
                    </h3>
                    <p className="text-xs font-semibold text-gray-500 tabular-nums mt-1">
                        {formatINRExact(displayed)}
                    </p>
                    <AnimatePresence>
                        {filtersActive && (
                            <motion.span
                                initial={{ opacity: 0, y: -4 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -4 }}
                                className="inline-flex w-fit mt-1.5 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 border border-amber-100 whitespace-nowrap"
                            >
                                incl. {activeLabels.join(" + ")}
                            </motion.span>
                        )}
                    </AnimatePresence>

                    {isFy && (
                        <p className="text-[11px] text-brand-700 font-semibold mt-2">
                            Financial year{fyStartLabel ? ` · since ${fyStartLabel}` : ""}
                        </p>
                    )}

                    {hasChange && (
                        <div className="flex items-center gap-1.5 mt-2">
                            <div
                                className={cn(
                                    "flex items-center text-[11px] font-bold px-1.5 py-0.5 rounded-full",
                                    isPositive
                                        ? "bg-emerald-50 text-emerald-600"
                                        : "bg-rose-50 text-rose-600",
                                )}
                            >
                                {isPositive ? (
                                    <ArrowUpRight className="w-3 h-3" />
                                ) : (
                                    <ArrowDownRight className="w-3 h-3" />
                                )}
                                {Math.abs(change as number).toFixed(1)}%
                            </div>
                            <span className="text-[11px] text-gray-400 font-medium">
                                vs last month
                            </span>
                        </div>
                    )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                    <button
                        type="button"
                        data-testid="revenue-filter-trigger"
                        aria-label="Filter revenue"
                        aria-expanded={open}
                        onClick={() => setOpen((v) => !v)}
                        className={cn(
                            "p-2 rounded-xl border transition-colors",
                            open || nonDefault
                                ? "bg-brand-50 border-brand-200 text-brand-600"
                                : "bg-white border-gray-200 text-gray-400 hover:text-brand-600 hover:border-brand-100",
                        )}
                    >
                        <SlidersHorizontal className="w-4 h-4" />
                    </button>
                    <div className="p-3 bg-gray-50 rounded-xl group-hover:bg-brand-50 transition-colors duration-300">
                        <DollarSign className="w-5 h-5 text-gray-400 group-hover:text-brand-600 transition-colors" />
                    </div>
                </div>
            </div>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, y: -6, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -6, scale: 0.97 }}
                        transition={{ duration: 0.16, ease: "easeOut" }}
                        data-testid="revenue-filter-popover"
                        className="absolute right-6 top-20 z-50 w-72 origin-top-right rounded-2xl bg-white border border-gray-100 shadow-xl shadow-gray-200/60 p-4"
                    >
                        <p className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">
                            Period
                        </p>
                        <div className="grid grid-cols-2 gap-1 p-1 bg-gray-100 rounded-xl mb-4">
                            <PeriodButton
                                testid="period-mtd"
                                label="This month"
                                active={!isFy}
                                onClick={() => setPeriod("mtd")}
                            />
                            <PeriodButton
                                testid="period-fy"
                                label="Financial year"
                                active={isFy}
                                onClick={() => setPeriod("fy")}
                            />
                        </div>

                        <p className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
                            Include in revenue
                        </p>

                        <FilterToggle
                            testid="toggle-void"
                            label="Void invoices"
                            amount={formatLakhs(activeVoid)}
                            checked={includeVoid}
                            onToggle={() => setIncludeVoid((v) => !v)}
                        />
                        <FilterToggle
                            testid="toggle-draft"
                            label="Draft invoices"
                            amount={formatLakhs(activeDraft)}
                            checked={includeDraft}
                            onToggle={() => setIncludeDraft((v) => !v)}
                        />

                        <p className="text-[11px] text-gray-400 leading-relaxed mt-3 pt-3 border-t border-gray-50">
                            {isFy
                                ? `Showing revenue since ${fyStartLabel ?? "1 Apr"}.`
                                : "Showing this month's revenue."}{" "}
                            Void &amp; draft are excluded unless toggled on.
                        </p>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

function PeriodButton({
    label,
    active,
    onClick,
    testid,
}: {
    label: string;
    active: boolean;
    onClick: () => void;
    testid: string;
}) {
    return (
        <button
            type="button"
            data-testid={testid}
            data-active={active ? "true" : "false"}
            onClick={onClick}
            className={cn(
                "py-1.5 px-2 rounded-lg text-xs font-semibold transition-colors",
                active
                    ? "bg-white text-brand-700 shadow-sm"
                    : "text-gray-500 hover:text-gray-700",
            )}
        >
            {label}
        </button>
    );
}

function FilterToggle({
    label,
    amount,
    checked,
    onToggle,
    testid,
}: {
    label: string;
    amount: string;
    checked: boolean;
    onToggle: () => void;
    testid: string;
}) {
    return (
        <button
            type="button"
            data-testid={testid}
            data-checked={checked ? "true" : "false"}
            onClick={onToggle}
            className="w-full flex items-center justify-between gap-3 py-2.5 px-2 -mx-2 rounded-xl hover:bg-gray-50 transition-colors text-left"
        >
            <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-800">{label}</p>
                <p className="text-[11px] text-gray-400 font-medium">{amount}</p>
            </div>
            <span
                className={cn(
                    "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-200",
                    checked ? "bg-brand-600" : "bg-gray-200",
                )}
            >
                <motion.span
                    layout
                    transition={{ type: "spring", stiffness: 500, damping: 32 }}
                    className={cn(
                        "inline-flex h-5 w-5 items-center justify-center rounded-full bg-white shadow-sm",
                        checked ? "ml-auto mr-0.5" : "ml-0.5",
                    )}
                >
                    {checked && (
                        <Check className="w-3 h-3 text-brand-600" strokeWidth={3} />
                    )}
                </motion.span>
            </span>
        </button>
    );
}
