"use client";

// ID 90 — the left menu's queue counts: how many items are WAITING for this
// role to act on in each work queue (Approvals, Reviews, Escalations, Ready to
// assign, Lead clean-up, Expense / Financing approvals, WhatsApp onboarding).
// One request to /api/admin/nav-counts, polled every 60 s like the other menu
// badges; the server answers only the queues the signed-in role has.
//
// Replaces useNavActivity's "new since you last opened it" badges on KYC
// review, Dealer validation and WhatsApp onboarding: those now show the same
// waiting number as the page.

import { useEffect, useState } from "react";

import { NAV_COUNT_IDS, type NavCountKey, type NavCounts } from "@/lib/nav/navCountKeys";

const POLL_MS = 60_000;

/** Sidebar item id → waiting count (ids with nothing waiting are absent). */
export function useNavCounts(enabled: boolean): Record<string, number> {
    const [counts, setCounts] = useState<NavCounts>({});

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        const load = () =>
            fetch("/api/admin/nav-counts", { cache: "no-store" })
                .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
                .then((j) => {
                    if (!cancelled && j?.data) setCounts(j.data as NavCounts);
                })
                .catch(() => {
                    /* silent — badges stay as they are on a failed poll */
                });
        void load();
        const t = window.setInterval(load, POLL_MS);
        // Returning to the tab is when a stale badge is most obvious.
        window.addEventListener("focus", load);
        return () => {
            cancelled = true;
            window.clearInterval(t);
            window.removeEventListener("focus", load);
        };
    }, [enabled]);

    const badges: Record<string, number> = {};
    for (const [key, n] of Object.entries(counts) as Array<[NavCountKey, number | undefined]>) {
        if (!n || n <= 0) continue;
        for (const id of NAV_COUNT_IDS[key] ?? []) badges[id] = n;
    }
    return badges;
}
