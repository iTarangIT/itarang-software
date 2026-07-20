"use client";

/**
 * Admin notifications — the full-page view of the buyback feed the header bell
 * shows, scoped by the API to iTarang staff. Same filters/search/archive/delete
 * as the dealer page; every row deep-links into the relevant admin page.
 *
 * Buyback-only by product decision: this shows `buyback.%` events, and its
 * mark-all is category-scoped, so an admin's KYC/escalation notifications are
 * neither shown here nor collaterally marked read.
 */

import NotificationCenter from "@/components/buyback/notifications/NotificationCenter";
import { PageHeader } from "@/components/buyback/ui";

export default function AdminBuybackNotificationsPage() {
  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader title="Notifications" sub="Every buyback event across dealers and vendors" />
        <div className="mt-4">
          <NotificationCenter />
        </div>
      </div>
    </div>
  );
}
