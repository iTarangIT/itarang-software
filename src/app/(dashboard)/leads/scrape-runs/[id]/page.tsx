"use client";

import { useParams, useRouter } from "next/navigation";
import { RunDetailView } from "@/components/scraper/RunDetailView";

export default function ScrapeRunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const runId = String(params?.id ?? "");

  return (
    <div className="flex-1 overflow-auto bg-gray-50/30">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <RunDetailView
          runId={runId}
          onBack={() => router.push("/leads?tab=scraper")}
          // A route change, so /leads mounts fresh and seeds its tab from
          // ?tab= — the "tab state is not URL-synced after mount" caveat only
          // applies to switching tabs in place, which this is not.
          onCampaignStarted={() => router.push("/leads?tab=campaigns")}
        />
      </div>
    </div>
  );
}
