"use client";

/**
 * /nbfc/settings shell — splits the settings into a handful of plain-language
 * tabs (left rail on desktop, scrolling pills on mobile) instead of one long
 * page of eleven sections. The active tab lives in `?tab=` so a refresh, a
 * router.refresh() after a save, or a shared link lands on the same tab.
 *
 * Every panel stays mounted (hidden with CSS) so unsaved form input in one tab
 * survives a look at another.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  Bell,
  Building2,
  ChevronRight,
  Layers,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  organisation: Building2,
  team: Users,
  services: Layers,
  wallet: Wallet,
  agents: Truck,
  notifications: Bell,
};

export interface SettingsTab {
  id: string;
  label: string;
  /** One line under the label in the rail and under the panel heading. */
  hint: string;
  content: ReactNode;
}

export default function SettingsTabs({
  tabs,
  initialTab,
}: {
  tabs: SettingsTab[];
  initialTab?: string;
}) {
  const valid = (id?: string | null) => !!id && tabs.some((t) => t.id === id);
  const [active, setActive] = useState(valid(initialTab) ? initialTab! : tabs[0].id);

  // Keep ?tab= in sync without a navigation (no server round-trip).
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("tab") !== active) {
      url.searchParams.set("tab", active);
      window.history.replaceState(window.history.state, "", url.toString());
    }
  }, [active]);

  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      {/* Mobile / tablet: horizontal pills */}
      <nav
        aria-label="Settings sections"
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 lg:hidden"
      >
        {tabs.map((t) => {
          const Icon = ICONS[t.id] ?? Layers;
          const on = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActive(t.id)}
              className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
                on
                  ? "border-[color:var(--color-brand-navy)] bg-[color:var(--color-brand-navy)] text-white shadow-sm"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
              }`}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </nav>

      {/* Desktop: left rail */}
      <nav
        aria-label="Settings sections"
        className="hidden w-64 shrink-0 lg:sticky lg:top-6 lg:block"
      >
        <ul className="space-y-1 rounded-xl border border-slate-200 bg-white p-2 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          {tabs.map((t) => {
            const Icon = ICONS[t.id] ?? Layers;
            const on = t.id === active;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setActive(t.id)}
                  aria-current={on ? "page" : undefined}
                  className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition ${
                    on
                      ? "bg-sky-50 text-[color:var(--color-brand-navy)] dark:bg-sky-900/30 dark:text-sky-200"
                      : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                  }`}
                >
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition ${
                      on
                        ? "bg-[color:var(--color-brand-navy)] text-white shadow-sm"
                        : "bg-slate-100 text-slate-500 group-hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400"
                    }`}
                  >
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{t.label}</span>
                    <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                      {t.hint}
                    </span>
                  </span>
                  <ChevronRight
                    className={`h-4 w-4 shrink-0 transition ${on ? "opacity-100" : "opacity-0 group-hover:opacity-40"}`}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Panels */}
      <div className="min-w-0 flex-1">
        <div className="mb-5">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            {current.label}
          </h2>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{current.hint}</p>
        </div>
        {tabs.map((t) => (
          <div key={t.id} hidden={t.id !== active} className="space-y-6">
            {t.content}
          </div>
        ))}
      </div>
    </div>
  );
}
