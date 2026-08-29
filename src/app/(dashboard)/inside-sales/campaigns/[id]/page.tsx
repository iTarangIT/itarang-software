"use client";

/**
 * Campaign detail for the Inside Sales Rep — the same lead table, bucket tabs
 * and per-lead transcript drawer the admin gets at /leads/campaigns/[id].
 *
 * CampaignDetailView is the entire page body, so this is a route shell and
 * nothing more. Mirrors the admin shell exactly except for `onBack`, which
 * returns the rep to their OWN campaign list rather than the admin console.
 */
import { useParams, useRouter } from "next/navigation";
import { CampaignDetailView } from "@/components/leads/campaign-detail-view";

export default function InsideSalesCampaignDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = String(params?.id ?? "");

  return (
    <div className="flex-1 overflow-auto bg-gray-50/30">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <CampaignDetailView
          campaignId={id}
          onBack={() => router.push("/inside-sales/campaigns")}
        />
      </div>
    </div>
  );
}
