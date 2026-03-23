"use client";

import { cn } from '@/lib/utils';
import type { ExplorationStatus } from '@/types/scraper';

interface Props {
    status: string;
    className?: string;
}

const STATUS_CONFIG: Record<
    ExplorationStatus,
    { label: string; className: string }
> = {
    unassigned: {
        label: 'Unassigned',
        className: 'bg-gray-100 text-gray-600',
    },
    assigned: {
        label: 'Assigned',
        className: 'bg-blue-100 text-blue-700',
    },
    exploring: {
        label: 'Exploring',
        className: 'bg-yellow-100 text-yellow-700',
    },
    explored: {
        label: 'Explored',
        className: 'bg-green-100 text-green-700',
    },
    not_interested: {
        label: 'Not Interested',
        className: 'bg-red-100 text-red-600',
    },
};

export function ExplorationStatusBadge({ status, className }: Props) {
    const config = STATUS_CONFIG[status as ExplorationStatus] ?? {
        label: status,
        className: 'bg-gray-100 text-gray-600',
    };

    return (
        <span
            className={cn(
                'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
                config.className,
                className
            )}
        >
            {config.label}
        </span>
    );
}

export function RunStatusBadge({
    status,
    className,
}: {
    status: string;
    className?: string;
}) {
    const config: Record<string, { label: string; className: string }> = {
        running: { label: 'Running', className: 'bg-blue-100 text-blue-700' },
        completed: { label: 'Completed', className: 'bg-green-100 text-green-700' },
        failed: { label: 'Failed', className: 'bg-red-100 text-red-600' },
        cancelled: { label: 'Cancelled', className: 'bg-gray-100 text-gray-600' },
    };

    const c = config[status] ?? { label: status, className: 'bg-gray-100 text-gray-600' };

    return (
        <span
            className={cn(
                'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
                c.className,
                className
            )}
        >
            {c.label}
        </span>
    );
}
