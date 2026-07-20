"use client";

/**
 * Dealer notifications — the full-page view of the buyback feed the header bell
 * shows, scoped by the API to this dealer. Filters, search, archive/delete, and
 * category-scoped mark-all; every row deep-links into the relevant dealer page.
 *
 * Static `notifications` segment as a sibling of `[id]` — Next.js resolves the
 * static segment first, so this never gets swallowed by the dynamic route.
 */

import NotificationCenter from "@/components/buyback/notifications/NotificationCenter";
import { PageHeader } from "@/components/buyback/ui";

export default function DealerNotificationsPage() {
  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader title="Notifications" sub="Every update on your buyback requests" />
        <div className="mt-4">
          <NotificationCenter />
        </div>
      </div>
    </div>
  );
}
