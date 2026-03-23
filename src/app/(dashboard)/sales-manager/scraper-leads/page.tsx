'use client';

import { SalesManagerLeadsView } from '@/components/scraper/SalesManagerLeadsView';

export default function ScraperLeadsPage() {
    return (
        <div className="flex-1 overflow-auto bg-gray-50/30">
            <div className="max-w-5xl mx-auto px-6 py-8">
                <SalesManagerLeadsView />
            </div>
        </div>
    );
}
