"use client";

import React from 'react';
import dynamic from 'next/dynamic';
import type { MetricsChartProps } from './charts-impl';

// recharts is ~100+ KB of client JS used only below the fold on dashboards —
// load it (and the chart implementation) on demand instead of in the shared
// bundle. The loading placeholder mirrors the impl's own pre-mount skeleton.
export const MetricsChart = dynamic(
    () => import('./charts-impl').then((m) => m.MetricsChart),
    {
        ssr: false,
        loading: () => (
            <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm h-full flex flex-col">
                <div className="flex-1" style={{ width: '100%', minHeight: 300 }} />
            </div>
        ),
    },
) as React.ComponentType<MetricsChartProps>;

export type { MetricsChartProps };
