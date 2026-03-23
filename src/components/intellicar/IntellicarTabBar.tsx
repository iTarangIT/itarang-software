'use client';

import { cn } from '@/lib/utils';
import { LayoutDashboard, Map, Heart, Bell, Wrench, Database } from 'lucide-react';

export type IntellicarTab = 'fleet' | 'trips' | 'health' | 'alerts' | 'devices' | 'database';

const tabs: { id: IntellicarTab; label: string; icon: React.ElementType }[] = [
    { id: 'fleet', label: 'Fleet Overview', icon: LayoutDashboard },
    { id: 'trips', label: 'Trip Analytics', icon: Map },
    { id: 'health', label: 'Health & Analytics', icon: Heart },
    { id: 'alerts', label: 'Alerts & Rules', icon: Bell },
    { id: 'devices', label: 'Device Management', icon: Wrench },
    { id: 'database', label: 'Database Health', icon: Database },
];

interface IntellicarTabBarProps {
    activeTab: IntellicarTab;
    onTabChange: (tab: IntellicarTab) => void;
}

export function IntellicarTabBar({ activeTab, onTabChange }: IntellicarTabBarProps) {
    return (
        <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-xl overflow-x-auto">
            {tabs.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                    <button
                        key={tab.id}
                        onClick={() => onTabChange(tab.id)}
                        className={cn(
                            'flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all whitespace-nowrap',
                            isActive
                                ? 'bg-white text-brand-700 shadow-sm'
                                : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                        )}
                    >
                        <tab.icon className={cn('w-4 h-4', isActive ? 'text-brand-600' : 'text-gray-400')} />
                        {tab.label}
                    </button>
                );
            })}
        </div>
    );
}
