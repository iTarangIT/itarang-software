'use client';

import { cn } from '@/lib/utils';

interface IntentBadgeProps {
    band?: string | null;
    score?: number | null;
    className?: string;
}

const bandConfig: Record<string, { bg: string; text: string; border: string; label: string }> = {
    high: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-100', label: 'High' },
    medium: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-100', label: 'Medium' },
    low: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-100', label: 'Low' },
};

export function IntentBadge({ band, score, className }: IntentBadgeProps) {
    if (!band) return <span className="text-xs text-gray-400">—</span>;

    const config = bandConfig[band.toLowerCase()] || bandConfig.low;

    return (
        <span className={cn(
            'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border',
            config.bg, config.text, config.border,
            className,
        )}>
            {score != null && <span className="font-bold">{score}</span>}
            {config.label}
        </span>
    );
}
