"use client";

/**
 * The dashboard a SCRAP dealer sees at /dealer-portal (E-202).
 *
 * A scrap dealer trades only in old batteries: no leads, no financing, no
 * assets, no OEM orders, no inventory. Rendering DealerDashboard for them would
 * be a page of modules they cannot use, so /dealer-portal routes them here
 * instead — their buyback dashboard IS their dashboard, rather than something
 * they have to click through to.
 *
 * Composition, not duplication: the identity / onboarding-status cards are the
 * same shared components DealerDashboard uses, and the body is the same
 * BuybackDashboardPanel that /dealer-portal/buyback renders. Nothing here is a
 * second copy of anything.
 */

import { useAuth } from "@/components/auth/AuthProvider";
import BuybackDashboardPanel from "./BuybackDashboardPanel";
import {
  DealerAccountStatusBanner,
  DealerIdentityCard,
  DealerOnboardingStatusCard,
} from "./shared/DealerProfileCards";
import { useDealerStats } from "./useDealerStats";
import { dealerTypeLabel } from "@/lib/dealer/dealer-type";

export default function ScrapDealerDashboard() {
  const { user, loading: authLoading } = useAuth();
  // Shares the request the portal page already made to route here.
  const { stats, loading } = useDealerStats();

  if (authLoading || loading) {
    return <div className="p-8 text-sm text-slate-500">Loading dashboard...</div>;
  }

  const dealer = stats?.dealer ?? null;
  const isApproved = !!dealer?.isApproved;
  const dealerName = dealer?.companyName || user?.name || "Dealer";
  const approvalStatusLabel = isApproved
    ? "Approved & Active"
    : (dealer?.reviewStatus || dealer?.onboardingStatus || "Pending review")
        .replaceAll("_", " ");

  return (
    <div className="animate-in space-y-8 fade-in duration-500 pb-10">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          Buyback Dashboard - {dealerName}
        </h1>
        <p className="mt-1 text-gray-500">
          {isApproved
            ? "Sell your old batteries to iTarang and track every request end to end."
            : "Your onboarding is under review. Buyback access will unlock after approval."}
        </p>
      </div>

      <DealerAccountStatusBanner
        isApproved={isApproved}
        activeMessage="Your dealer workspace is fully enabled. You can raise buyback requests, negotiate offers, and track pickups and payments from this dashboard."
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <DealerIdentityCard
          dealerName={dealerName}
          dealerId={dealer?.dealerCode || "Pending Approval"}
          companyType={user?.company_type || "Not available"}
          gstNumber={user?.gst_number || "Not available"}
          dealerTypeLabel={dealerTypeLabel(dealer?.dealerType, "")}
        />

        <DealerOnboardingStatusCard
          isApproved={isApproved}
          statusLabel={approvalStatusLabel}
          // A scrap dealer does not sell financed batteries, so "Finance
          // Enabled: No" would read as a missing capability rather than an
          // irrelevant one.
          financeEnabledValue={null}
          submittedAt={dealer?.submittedAt}
          approvedAt={dealer?.approvedAt}
        />
      </div>

      <BuybackDashboardPanel dealerName={dealerName} title="Battery Buyback" />
    </div>
  );
}
