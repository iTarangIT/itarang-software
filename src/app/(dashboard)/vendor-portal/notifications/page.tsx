"use client";

/**
 * Vendor notifications — the full-page view of the buyback feed the header bell
 * shows, scoped by the API to this vendor. Now the shared NotificationCenter
 * (filters, search, archive/delete, category mark-all); rows deep-link to the
 * vendor's own list surfaces (inbox / bids / orders / payments), never to a
 * dealer or admin deal page.
 */

import NotificationCenter from "@/components/buyback/notifications/NotificationCenter";

import { VendorPageShell } from "../_shared";

export default function VendorNotificationsPage() {
  return (
    <VendorPageShell title="Notifications" subtitle="Updates on your quotations and won lots">
      <NotificationCenter />
    </VendorPageShell>
  );
}
