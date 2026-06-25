"use client";

import React from 'react';
import { cn } from '@/lib/utils';
import { ArrowUpRight, ArrowDownRight, LucideIcon } from 'lucide-react';

interface KPICardProps {
    title: string;
    value: string | number;
    /** Optional exact figure shown beneath the headline value (e.g. "₹1,95,16,513.60"). */
    exactValue?: string;
    /** Optional muted context line under the value (e.g. "12 of 800 leads"). */
    subtitle?: string;
    change?: {
        value: number;
        period: string;
        isPositive: boolean;
    };
    icon: LucideIcon;
    className?: string;
    /** When provided, the whole card becomes a clickable button (e.g. drill-down). */
    onClick?: () => void;
}

export function KPICard({
    title,
    value,
    exactValue,
    subtitle,
    change,
    icon: Icon,
    className,
    onClick
}: KPICardProps) {
    return (
        <div
            role={onClick ? "button" : undefined}
            tabIndex={onClick ? 0 : undefined}
            onClick={onClick}
            onKeyDown={
                onClick
                    ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onClick();
                          }
                      }
                    : undefined
            }
            className={cn(
            "p-6 rounded-2xl bg-white/80 backdrop-blur-sm border border-gray-100 shadow-sm transition-all duration-300 hover:shadow-md hover:border-brand-100 group",
            onClick && "cursor-pointer",
            className
        )}>
            <div className="flex items-start justify-between">
                <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-500 mb-1">{title}</p>
                    <h3 className="text-3xl font-bold text-gray-900 tracking-tight">{value}</h3>

                    {exactValue && (
                        <p className="text-xs font-semibold text-gray-500 tabular-nums mt-1">{exactValue}</p>
                    )}

                    {subtitle && (
                        <p className="text-xs text-gray-400 font-medium mt-1.5">{subtitle}</p>
                    )}

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
