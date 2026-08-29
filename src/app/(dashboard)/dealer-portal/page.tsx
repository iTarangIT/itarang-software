"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import DealerDashboard from "@/components/dealer-dashboard/DealerDashboard";
import ScrapDealerDashboard from "@/components/dealer-dashboard/ScrapDealerDashboard";
import { useAuth } from "@/components/auth/AuthProvider";
import { fetchDealerStats } from "@/components/dealer-dashboard/useDealerStats";
import { capabilitiesFor } from "@/lib/dealer/dealer-capabilities";
import { normalizeDealerType, type DealerTypeValue } from "@/lib/dealer/dealer-type";

export default function DealerPortalPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  // E-202 — which dashboard this dealer gets. A SCRAP dealer has no leads,
  // loans, assets or orders, so DealerDashboard would be a page of modules they
  // cannot use; they get the buyback dashboard in its place. 'new' and 'both'
  // both get DealerDashboard, which gates its own buyback surfaces internally.
  //
  // `null` means "not resolved yet" and is deliberately distinct from "new" —
  // rendering DealerDashboard while the type is still loading would flash the
  // wrong dashboard at a scrap dealer on every visit.
  const [dealerType, setDealerType] = useState<DealerTypeValue | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) router.push("/login");
  }, [loading, user, router]);

  useEffect(() => {
    if (loading || !user) return;
    let cancelled = false;

    // Shared with the dashboard this resolves to — one request, not two.
    fetchDealerStats().then((data) => {
      if (cancelled) return;
      // Unclassifiable → the portal they have today, not a blank page.
      setDealerType(normalizeDealerType(data?.dealer?.dealerType) ?? "new");
    });

    return () => {
      cancelled = true;
    };
  }, [loading, user]);

  if (loading || (user && dealerType === null)) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <p className="text-slate-500">Loading dealer portal...</p>
      </div>
    );
  }

  if (!user) return null;

  return capabilitiesFor(dealerType).newBattery ? (
    <DealerDashboard />
  ) : (
    <ScrapDealerDashboard />
  );
}
