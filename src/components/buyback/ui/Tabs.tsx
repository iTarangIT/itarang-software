"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * URL-driven tabs — proto tabs() (iTarang Portal.dc.html:664), but
 * query-param backed instead of component state so a tab survives a
 * refresh/share link. "use client" — it reads the URL via next/navigation
 * hooks.
 *
 * API: this file exports BOTH the tab bar (`Tabs`) and a standalone hook
 * (`useActiveTab`) that resolves the same active key from the same query
 * param. Callers render <Tabs .../> for the bar, then call useActiveTab(...)
 * with the SAME items/param/defaultKey to decide what content to show below
 * — one source of truth (the URL), read by both, so the bar and the content
 * can never disagree about which tab is active.
 */
export interface TabItem {
  key: string;
  label: string;
}

export function useActiveTab(items: TabItem[], param = "tab", defaultKey?: string): string {
  const searchParams = useSearchParams();
  const fallback = defaultKey ?? items[0]?.key ?? "";
  const raw = searchParams.get(param);
  return raw && items.some((i) => i.key === raw) ? raw : fallback;
}

export default function Tabs({
  items,
  param = "tab",
  defaultKey,
}: {
  items: TabItem[];
  param?: string;
  defaultKey?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = useActiveTab(items, param, defaultKey);

  const go = (key: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set(param, key);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  return (
    <div className="mt-[18px] flex gap-1 border-b border-gray-200">
      {items.map((item) => (
        <div
          key={item.key}
          onClick={() => go(item.key)}
          className={`-mb-px cursor-pointer border-b-2 px-[15px] py-[9px] text-[13px] font-semibold ${
            active === item.key ? "border-green-600 text-bb-navy" : "border-transparent text-slate-500"
          }`}
        >
          {item.label}
        </div>
      ))}
    </div>
  );
}
