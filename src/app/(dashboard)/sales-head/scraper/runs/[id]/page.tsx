'use client';

import { RunDetailView } from '@/components/scraper/RunDetailView';

export default function ScraperRunDetailPage() {
    return (
        <div className="flex-1 overflow-auto bg-gray-50/30">
            <div className="max-w-6xl mx-auto px-6 py-8">
                <RunDetailView />
            </div>
        </div>
    );
}
