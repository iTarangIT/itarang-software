"use client";

import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Receipt, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatINRCompact, formatINRExact } from "@/lib/format";
import { MonthCalendar } from "./MonthCalendar";

interface ExpensesMtdCardProps {
  /** Current-month approved-expense total, used as the instant default. */
  defaultMtd: number;
  /** Optional click handler to open a drill-down of the active window. */
  onClick?: (period: string) => void;
}

type Selection = { kind: "mtd" } | { kind: "fy" } | { kind: "month"; value: string };

export function ExpensesMtdCard({ defaultMtd, onClick }: ExpensesMtdCardProps) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<Selection>({ kind: "mtd" });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
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

  const queryParam =
    selection.kind === "month"
      ? `month=${selection.value}`
      : `period=${selection.kind}`;
  const isDefault = selection.kind === "mtd";

  const { data, isFetching } = useQuery({
    queryKey: ["ceo-expenses-summary", queryParam],
    queryFn: async () => {
      const r = await fetch(`/api/dashboard/ceo/expenses-summary?${queryParam}`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error("Failed to load expenses");
      const j = await r.json();
      return j.data as { total: number; period: string; label: string };
    },
    // Seed the current-month figure so the card renders instantly.
    initialData: isDefault
      ? { total: defaultMtd, period: "mtd", label: "This month" }
      : undefined,
  });

  const total = data?.total ?? defaultMtd;
  const label =
    selection.kind === "fy"
      ? "Financial year"
      : data?.label ?? "This month";

  return (
    <div
      ref={containerRef}
      data-testid="expenses-card"
      className={cn(
        "relative p-6 rounded-2xl bg-white/80 backdrop-blur-sm border border-gray-100 shadow-sm transition-all duration-300 hover:shadow-md hover:border-brand-100 group",
        open && "z-40",
      )}
    >
      <div className="flex items-start justify-between">
        <div
          className={cn("min-w-0", onClick && "cursor-pointer")}
          onClick={onClick ? () => onClick(queryParam) : undefined}
        >
          <p className="text-sm font-medium text-gray-500 mb-1">Expenses</p>
          <h3 className="text-3xl font-bold text-gray-900 tracking-tight">
            {formatINRCompact(total)}
          </h3>
          <p className="text-xs font-semibold text-gray-500 tabular-nums mt-1">
            {formatINRExact(total)}
          </p>
          <p className="text-xs text-gray-400 font-medium mt-1.5">
            Approved expenses · {label}
            {isFetching && !isDefault ? " …" : ""}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            data-testid="expenses-filter-trigger"
            aria-label="Filter expenses"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className={cn(
              "p-2 rounded-xl border transition-colors",
              open || !isDefault
                ? "bg-brand-50 border-brand-200 text-brand-600"
                : "bg-white border-gray-200 text-gray-400 hover:text-brand-600 hover:border-brand-100",
            )}
          >
            <SlidersHorizontal className="w-4 h-4" />
          </button>
          <div className="p-3 bg-gray-50 rounded-xl group-hover:bg-brand-50 transition-colors duration-300">
            <Receipt className="w-5 h-5 text-gray-400 group-hover:text-brand-600 transition-colors" />
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
            data-testid="expenses-filter-popover"
            className="absolute right-6 top-20 z-50 w-72 origin-top-right rounded-2xl bg-white border border-gray-100 shadow-xl shadow-gray-200/60 p-4"
          >
            <p className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">
              Period
            </p>
            <div className="grid grid-cols-2 gap-1 p-1 bg-gray-100 rounded-xl mb-3">
              <PeriodButton
                label="This month"
                active={selection.kind === "mtd"}
                onClick={() => setSelection({ kind: "mtd" })}
              />
              <PeriodButton
                label="Financial year"
                active={selection.kind === "fy"}
                onClick={() => setSelection({ kind: "fy" })}
              />
            </div>

            <MonthCalendar
              value={selection.kind === "month" ? selection.value : null}
              onSelect={(value) => {
                setSelection({ kind: "month", value });
                setOpen(false);
              }}
            />
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
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "py-1.5 px-2 rounded-lg text-xs font-semibold transition-colors",
        active ? "bg-white text-brand-700 shadow-sm" : "text-gray-500 hover:text-gray-700",
      )}
    >
      {label}
    </button>
  );
}
