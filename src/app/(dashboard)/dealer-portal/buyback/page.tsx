"use client";

/**
 * M01 — the dealer's buyback dashboard route.
 *
 * The body lives in BuybackDashboardPanel because it has a second mount point:
 * a SCRAP dealer's /dealer-portal is this dashboard (E-202), so it cannot stay
 * inside a route file. This page is the wrapper — chrome and the greeting name.
 */

import { useAuth } from "@/components/auth/AuthProvider";
import BuybackDashboardPanel from "@/components/dealer-dashboard/BuybackDashboardPanel";

export default function DealerBuybackPage() {
  const { user } = useAuth();

  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <BuybackDashboardPanel dealerName={user?.name} />
      </div>
    </div>
  );
}
