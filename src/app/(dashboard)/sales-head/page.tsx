import { Suspense } from 'react';
import { SalesHeadOpsView } from '@/components/dashboard/sales/SalesHeadOpsView';

export const dynamic = 'force-dynamic';

// Sales Head operations — the same screen as /admin/reports/sales-dashboard.
// Filters live in the URL (useSearchParams), hence the Suspense boundary.
export default function SalesHeadDashboard() {
    return (
        <Suspense fallback={<div className="p-8 text-center text-sm text-ink-muted">Loading…</div>}>
            <SalesHeadOpsView />
        </Suspense>
    );
}
