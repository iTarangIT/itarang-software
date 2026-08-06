import React from "react";

import { requireOperationsPage } from "@/lib/operations/route-guard";

import { OpsNavTabs } from "./_components/OpsNavTabs";

/**
 * Ops Console shell.
 *
 * The role gate lives here rather than on each page so a new module cannot
 * ship unguarded — the failure mode this replaces (every page repeating its own
 * `requireX()`) is one page quietly forgetting to.
 *
 * `force-dynamic` is inherited from (dashboard)/layout.tsx; the chrome
 * (sidebar + header) comes from LayoutWrapper there. This adds only the
 * console's own title bar and tab strip.
 */
export default async function OperationsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireOperationsPage();

  return (
    <div className="space-y-4 p-4 md:p-6">
      <header className="space-y-3">
        <div>
          <h1 className="text-xl font-semibold text-brand-navy">Ops Console</h1>
          <p className="text-xs text-ink-muted">
            Infrastructure, database, spend and business health in one place.
          </p>
        </div>
        <OpsNavTabs />
      </header>
      {children}
    </div>
  );
}
