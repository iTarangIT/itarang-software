"use client";

/**
 * Dealer notifications — the full-page view of the bell feed.
 *
 * Everything iTarang admin or an NBFC partner has done on this dealer's leads:
 * KYC verdicts, requested documents and co-borrower requests, correction
 * requests forwarded from an NBFC, sanction and rejection, dispatch and
 * delivery, onboarding decisions, inventory assignments and transfers, buyback.
 *
 * These rows existed all along and were invisible — they were written keyed only
 * to `dealer_id` while the bell reads `user_id`. The feed now matches both, so
 * the history is here too, not just what arrived after the fix.
 */

import NotificationCenter from "@/components/notifications/NotificationCenter";

export default function DealerNotificationsPage() {
  return (
    <div>
      <div className="mb-4">
        <h1 className="text-xl font-bold text-slate-900">Notifications</h1>
        <p className="mt-0.5 text-[12.5px] text-slate-500">
          Every action taken on your leads and your account, and what needs you next.
        </p>
      </div>
      <NotificationCenter />
    </div>
  );
}
