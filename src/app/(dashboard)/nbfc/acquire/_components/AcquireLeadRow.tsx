"use client";

/**
 * Clickable lead-pipeline row (Acquire workspace, Addendum V0.3.1 §13.1).
 *
 * The whole row navigates to the per-lead detail — not just the Lead ID link —
 * so operators can click anywhere on the application to open it. The Lead ID
 * remains a real <Link> (keyboard focus, middle-click / open-in-new-tab); a
 * click on it is allowed to navigate on its own and we stop the row handler
 * from double-firing. Clicks on text-selection are ignored so operators can
 * still copy a phone number without being navigated away.
 */
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

export default function AcquireLeadRow({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const router = useRouter();

  return (
    <tr
      onClick={(e) => {
        // Don't hijack a real link/button click inside the row.
        if ((e.target as HTMLElement).closest("a,button")) return;
        // Let the operator select/copy text without navigating.
        if (window.getSelection()?.toString()) return;
        router.push(href);
      }}
      className="border-t border-slate-100 hover:bg-slate-50 transition cursor-pointer"
    >
      {children}
    </tr>
  );
}
