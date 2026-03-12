"use client";

import React from 'react';
import { cn } from '@/lib/utils';
import { ArrowUpRight, ArrowDownRight, LucideIcon } from 'lucide-react';

interface KPICardProps {
    title: string;
    value: string | number;
    change?: {
        value: number;
        period: string;
        isPositive: boolean;
    };
    icon: LucideIcon;
    className?: string;
}

export function KPICard({
    title,
    value,
    change,
    icon: Icon,
    className
}: KPICardProps) {
    return (
        <div className={cn(
            "p-6 rounded-2xl bg-white/80 backdrop-blur-sm border border-gray-100 shadow-sm transition-all duration-300 hover:shadow-md hover:border-brand-100 group",
            className
        )}>
            <div className="flex items-start justify-between">
                <div>
                    <p className="text-sm font-medium text-gray-500 mb-1">{title}</p>
                    <h3 className="text-2xl font-bold text-gray-900 tracking-tight">{value}</h3>

                    {change && (
                        <div className="flex items-center gap-1.5 mt-2">
                            <div className={cn(
                                "flex items-center text-[11px] font-bold px-1.5 py-0.5 rounded-full",
                                change.isPositive
                                    ? "bg-emerald-50 text-emerald-600"
                                    : "bg-rose-50 text-rose-600"
                            )}>
                                {change.isPositive ? (
                                    <ArrowUpRight className="w-3 h-3" />
                                ) : (
                                    <ArrowDownRight className="w-3 h-3" />
                                )}
                                {Math.abs(change.value)}%
                            </div>
                            <span className="text-[11px] text-gray-400 font-medium">{change.period}</span>
                        </div>
                    )}
                </div>

                <div className="p-3 bg-gray-50 rounded-xl group-hover:bg-brand-50 transition-colors duration-300">
                    <Icon className="w-5 h-5 text-gray-400 group-hover:text-brand-600 transition-colors" />
                </div>
            </div>
        </div>
    );
}
