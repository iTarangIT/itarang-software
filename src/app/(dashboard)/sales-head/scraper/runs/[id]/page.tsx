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
                <RunDetailView runId={runId} onBack={() => router.back()} />
            </div>
        </div>
    );
}
