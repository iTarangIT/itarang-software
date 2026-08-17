'use client';

import { useParams, useRouter } from 'next/navigation';
import { RunDetailView } from '@/components/scraper/RunDetailView';

export default function ScraperRunDetailPage() {
    const params = useParams();
    const router = useRouter();
    const runId = String(params?.id ?? '');

    return (
        <div className="flex-1 overflow-auto bg-gray-50/30">
            <div className="max-w-6xl mx-auto px-6 py-8">
                <RunDetailView
                    runId={runId}
                    onBack={() => router.back()}
                    // Explicit rather than router.back(): after starting a
                    // campaign the useful destination is the campaign, not
                    // wherever the user happened to come from. /leads is
                    // reachable for sales_head — it is in middleware's
                    // isProtectedRoute but is not a roleDashboards prefix, so
                    // the wrong-role bounce does not fire for it.
                    onCampaignStarted={() => router.push('/leads?tab=campaigns')}
                />
            </div>
        </div>
    );
}
