"use client";

/**
 * E-292 — the refurbisher's notifications page: the full-page view of the
 * header bell, scoped by the API to this login. Rows deep-link into
 * /refurbisher-portal/lots/<id>.
 */
import NotificationCenter from "@/components/notifications/NotificationCenter";

export default function RefurbisherNotificationsPage() {
  return (
    <main className="mx-auto max-w-[100rem] p-6">
      <h1 className="text-xl font-semibold mb-4">Notifications</h1>
      <NotificationCenter />
    </main>
  );
}
