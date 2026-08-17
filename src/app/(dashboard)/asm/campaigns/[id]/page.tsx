"use client";

/**
 * Campaign detail for the ASM — route shell around the shared
 * CampaignDetailView, identical to the inside-sales twin except for `onBack`.
 */
import { useParams, useRouter } from "next/navigation";
import { CampaignDetailView } from "@/components/leads/campaign-detail-view";

export default function AsmCampaignDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = String(params?.id ?? "");

  return (
    <div className="flex-1 overflow-auto bg-gray-50/30">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <CampaignDetailView
          campaignId={id}
          onBack={() => router.push("/asm/campaigns")}
        />
      </div>
    </div>
  );
}
