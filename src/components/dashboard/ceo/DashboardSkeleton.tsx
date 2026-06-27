"use client";

import React from "react";

// Pulse placeholder mirroring the CEO dashboard layout so the page keeps its
// shape while metrics load (instead of a full-screen spinner swap).
const Block = ({ className = "" }: { className?: string }) => (
    <div className={`rounded-2xl bg-gray-100 animate-pulse ${className}`} />
);

export function DashboardSkeleton() {
    return (
        <div className="space-y-8 pb-12" data-testid="ceo-dashboard-skeleton">
            {/* Header */}
            <div className="flex justify-between items-center">
                <div className="space-y-2">
                    <Block className="h-7 w-72" />
                    <Block className="h-4 w-56" />
                </div>
                <Block className="h-10 w-32" />
            </div>

            {/* KPI row */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {Array.from({ length: 4 }).map((_, i) => (
                    <Block key={i} className="h-32" />
                ))}
            </div>

            {/* Analytics row */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
                <div className="lg:col-span-2 space-y-6">
                    <Block className="h-[380px]" />
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
                        <Block className="h-44" />
                        <Block className="h-44" />
                        <Block className="h-44" />
                    </div>
                </div>
                <Block className="h-[560px]" />
            </div>

            {/* Sales managers */}
            <Block className="h-40" />
        </div>
    );
}
