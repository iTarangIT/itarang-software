"use client";

import { useParams, useRouter } from "next/navigation";
import { CampaignDetailView } from "@/components/leads/campaign-detail-view";

export default function CampaignDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = String(params?.id ?? "");

  return (
    <div className="flex-1 overflow-auto bg-gray-50/30">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <CampaignDetailView
          campaignId={id}
          onBack={() => router.push("/leads?tab=campaigns")}
        />
      </div>
    </div>
  );
}
