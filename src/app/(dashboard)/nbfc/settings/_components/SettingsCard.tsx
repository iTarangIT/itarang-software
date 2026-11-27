/**
 * Shared look for every /nbfc/settings card: an icon tile, a plain-language
 * title, a one-line description and an optional right-hand slot (a button, a
 * balance, a count). Keeps all tabs visually consistent.
 */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export const CARD =
  "rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900";

const TONES = {
  sky: "bg-sky-50 text-sky-700",
  emerald: "bg-emerald-50 text-emerald-700",
  violet: "bg-violet-50 text-violet-700",
  amber: "bg-amber-50 text-amber-700",
  rose: "bg-rose-50 text-rose-600",
  indigo: "bg-indigo-50 text-indigo-700",
  teal: "bg-teal-50 text-teal-700",
} as const;

export function SectionHeader({
  icon: Icon,
  tone = "sky",
  title,
  desc,
  children,
}: {
  icon: LucideIcon;
  tone?: keyof typeof TONES;
  title: ReactNode;
  desc?: ReactNode;
  /** Right-hand slot. */
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${TONES[tone]}`}
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0">
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
          {desc ? (
            <p className="mt-0.5 max-w-3xl text-sm leading-relaxed text-slate-500">{desc}</p>
          ) : null}
        </div>
      </div>
      {children ? <div className="shrink-0">{children}</div> : null}
    </div>
  );
}
