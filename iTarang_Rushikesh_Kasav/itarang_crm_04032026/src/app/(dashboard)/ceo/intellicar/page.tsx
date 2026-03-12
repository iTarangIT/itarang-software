'use client';

import { Suspense, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { IntellicarTabBar, type IntellicarTab } from '@/components/intellicar/IntellicarTabBar';
import { FleetOverview } from '@/components/intellicar/FleetOverview';
import { TripAnalytics } from '@/components/intellicar/TripAnalytics';
import { HealthAnalytics } from '@/components/intellicar/HealthAnalytics';
import { AlertsRules } from '@/components/intellicar/AlertsRules';
import { DeviceManagement } from '@/components/intellicar/DeviceManagement';
import { DatabaseHealth } from '@/components/intellicar/DatabaseHealth';

const tabComponents: Record<IntellicarTab, React.ComponentType> = {
    fleet: FleetOverview,
    trips: TripAnalytics,
    health: HealthAnalytics,
    alerts: AlertsRules,
    devices: DeviceManagement,
    database: DatabaseHealth,
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

    const ActiveComponent = tabComponents[activeTab] || FleetOverview;

    return (
        <div className="space-y-6 pb-12">
            <div>
                <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Intellicar Dashboard</h1>
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
