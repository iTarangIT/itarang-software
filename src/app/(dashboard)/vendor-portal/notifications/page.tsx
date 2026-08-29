"use client";

/**
 * Vendor notifications — the full-page view of the header bell's feed, scoped by
 * the API to this vendor.
 *
 * Reads the CRM-wide feed rather than the buyback-only one. In practice nearly
 * everything a scrap vendor receives IS a buyback event, so what shows up is
 * much the same — but this is the vendor's ONLY notifications page (the admin
 * and dealer buyback centres live under their own /buyback/ routes), so
 * narrowing it would hide anything non-buyback addressed to them. Rows still
 * deep-link to the vendor's own list surfaces (inbox / bids / orders /
 * payments), never to a dealer or admin deal page.
 */

import NotificationCenter from "@/components/notifications/NotificationCenter";

import { VendorPageShell } from "../_shared";

export default function VendorNotificationsPage() {
  return (
    <VendorPageShell title="Notifications" subtitle="Updates on your quotations and won lots">
      <NotificationCenter />
    </VendorPageShell>
  );
}
