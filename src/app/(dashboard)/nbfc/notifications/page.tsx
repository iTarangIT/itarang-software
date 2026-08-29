"use client";

/**
 * NBFC partner notifications — the full-page view of the bell feed.
 *
 * The NBFC portal previously had no notification history at all: its bell showed
 * live work-queue counts only, so nothing that HAPPENED was ever recorded — an
 * admin pushing requested documents, a dealer uploading, a verdict answered, a
 * VKYC captured, an E-NACH confirmed, an agreement signed, a lead routed here or
 * lost to another lender. All of it lands here now, with the provenance line
 * saying who sent it and what stage it is at.
 */

import NotificationCenter from "@/components/notifications/NotificationCenter";

export default function NbfcNotificationsPage() {
  return (
    <div className="px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-[1180px]">
        <div className="mb-4">
          <h1 className="text-xl font-bold text-slate-900">Notifications</h1>
          <p className="mt-0.5 text-[12.5px] text-slate-500">
            Every update on your routed leads — documents, verifications, agreements and
            decisions.
          </p>
        </div>
        <NotificationCenter />
      </div>
    </div>
  );
}
