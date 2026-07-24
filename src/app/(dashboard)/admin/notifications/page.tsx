"use client";

/**
 * Admin notifications — the full-page view of the bell feed.
 *
 * CRM-wide, unlike /admin/buyback/notifications which stays scoped to
 * `buyback.%`: everything addressed to this admin lands here — new leads, KYC
 * submissions and consent, the NBFC ⇄ admin ⇄ dealer request loop, FI / Video
 * KYC / E-NACH / agreement, product selection, sanction and disbursal, dealer
 * onboarding (portal and WhatsApp), inventory and escalations. Rows that carry
 * a one-click action (Forward to dealer, Push to NBFC, Decline) can be actioned
 * without leaving the page.
 */

import NotificationCenter from "@/components/notifications/NotificationCenter";

export default function AdminNotificationsPage() {
  return (
    <div>
      <div className="mb-4">
        <h1 className="text-xl font-bold text-slate-900">Notifications</h1>
        <p className="mt-0.5 text-[12.5px] text-slate-500">
          Every request and action across dealers, NBFC partners and vendors — and who it is
          waiting on.
        </p>
      </div>
      <NotificationCenter />
    </div>
  );
}
