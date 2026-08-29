'use client';

import { Suspense, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams, useRouter } from 'next/navigation';
import { IntellicarTabBar, type IntellicarTab } from '@/components/intellicar/IntellicarTabBar';

// Only one tab is ever on screen, so loading all six eagerly makes every visitor pay for
// five they are not looking at — including recharts (~100 KB), which two of them pull in at
// module scope. Splitting them per tab means the entry bundle carries the tab bar and
// nothing else.
const tabLoading = () => (
    <div className="p-12 text-center text-gray-400 text-sm">Loading…</div>
);

const tabComponents: Record<IntellicarTab, React.ComponentType> = {
    fleet: dynamic(() => import('@/components/intellicar/FleetOverview').then((m) => m.FleetOverview), { loading: tabLoading }),
    battery: dynamic(() => import('@/components/intellicar/battery/BatteryAnalytics').then((m) => m.BatteryAnalytics), { loading: tabLoading }),
    trips: dynamic(() => import('@/components/intellicar/TripAnalytics').then((m) => m.TripAnalytics), { loading: tabLoading }),
    health: dynamic(() => import('@/components/intellicar/HealthAnalytics').then((m) => m.HealthAnalytics), { loading: tabLoading }),
    alerts: dynamic(() => import('@/components/intellicar/AlertsRules').then((m) => m.AlertsRules), { loading: tabLoading }),
    devices: dynamic(() => import('@/components/intellicar/DeviceManagement').then((m) => m.DeviceManagement), { loading: tabLoading }),
    database: dynamic(() => import('@/components/intellicar/DatabaseHealth').then((m) => m.DatabaseHealth), { loading: tabLoading }),
};

function IntellicarDashboardContent() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const initialTab = (searchParams.get('tab') as IntellicarTab) || 'fleet';
    const [activeTab, setActiveTab] = useState<IntellicarTab>(initialTab);

    const handleTabChange = (tab: IntellicarTab) => {
        setActiveTab(tab);
        router.replace(`/ceo/intellicar?tab=${tab}`, { scroll: false });
    };

    const ActiveComponent = tabComponents[activeTab] || tabComponents.fleet;

    return (
        <div className="space-y-6 pb-12">
            <div>
                <h1 className="text-2xl font-bold text-gray-900 tracking-tight">IoT Dashboard</h1>
                <p className="text-sm text-gray-500 mt-1">Battery fleet monitoring and telemetry analytics</p>
            </div>

            <IntellicarTabBar activeTab={activeTab} onTabChange={handleTabChange} />

            <ActiveComponent />
        </div>
    );
}

export default function IntellicarDashboardPage() {
    return (
        <Suspense fallback={<div className="p-8 text-center text-gray-500">Loading dashboard...</div>}>
            <IntellicarDashboardContent />
        </Suspense>
    );
}
