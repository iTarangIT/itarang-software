"use client";

/**
 * Notifications — the full-page view of the same buyback feed the header bell
 * shows, scoped by the API to this caller. Read-only here: the bell's row links
 * point at dealer/admin deal pages a vendor can't open, so this page shows the
 * message and time and offers only "mark all read".
 */

import { useCallback, useEffect, useState } from "react";

import { Card, EmptyState } from "@/components/buyback/ui";

import { fmtDate, VendorPageShell } from "../_shared";

interface Note {
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean | null;
  created_at: string;
}

export default function VendorNotificationsPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [marking, setMarking] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/buyback/notifications");
      const json = await res.json();
      if (json?.success === false) return;
      setNotes(json?.data?.notifications ?? []);
      setUnread(json?.data?.unread_count ?? 0);
    } catch {
      /* silent — a notifications page that can't load is not worth an alarm */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const markAllRead = async () => {
    setMarking(true);
    try {
      await fetch("/api/buyback/notifications", { method: "PATCH" });
      await load();
    } finally {
      setMarking(false);
    }
  };

  return (
    <VendorPageShell title="Notifications" subtitle="Updates on your quotations and won lots">
      {loading ? (
        <p className="py-16 text-center text-sm text-slate-400">Loading…</p>
      ) : notes.length === 0 ? (
        <EmptyState
          icon="🔔"
          title="Nothing yet"
          body="Updates on your quotations — new lots, counters, and won deals — will appear here."
        />
      ) : (
        <Card
          title="Recent"
          action={
            unread > 0 ? (
              <button
                onClick={() => void markAllRead()}
                disabled={marking}
                className="text-[11.5px] font-semibold text-blue-600 hover:underline disabled:opacity-50"
              >
                {marking ? "Marking…" : "Mark all read"}
              </button>
            ) : undefined
          }
        >
          <ul className="divide-y divide-slate-100">
            {notes.map((n) => {
              const isUnread = n.read !== true;
              return (
                <li
                  key={n.id}
                  className={`flex gap-2.5 px-[18px] py-3.5 ${isUnread ? "bg-blue-50/40" : ""}`}
                >
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                      isUnread ? "bg-blue-500" : "bg-transparent"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-semibold text-slate-900">{n.title}</div>
                    <div className="mt-0.5 text-[12px] text-slate-500">{n.message}</div>
                    <div className="mt-1 text-[10.5px] text-slate-400">{fmtDate(n.created_at)}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </VendorPageShell>
  );
}
