'use client';

import { ScraperDashboard } from '@/components/scraper/ScraperDashboard';

export default function DealerScraperPage() {
    return (
        <div className="flex-1 overflow-auto bg-gray-50/30">
            <div className="max-w-6xl mx-auto px-6 py-8">
                <ScraperDashboard />
            </div>
        </div>
    );
}
