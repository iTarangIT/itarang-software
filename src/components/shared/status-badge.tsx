import React from 'react';
import { cn } from '@/lib/utils';

type StatusType = 'success' | 'warning' | 'error' | 'info' | 'pending' | 'active' | 'inactive';

interface StatusBadgeProps {
    status: string;
    type?: StatusType;
    className?: string;
}

const statusMap: Record<string, { type: StatusType, label: string }> = {
    // Common
    'active': { type: 'success', label: 'Active' },
    'inactive': { type: 'error', label: 'Inactive' },
    'pending': { type: 'pending', label: 'Pending' },

    // Lead Statuses
    'new': { type: 'info', label: 'New' },
    'contacted': { type: 'info', label: 'Contacted' },
    'qualified': { type: 'success', label: 'Qualified' },
    'converted': { type: 'success', label: 'Converted' },
    'lost': { type: 'error', label: 'Lost' },

    // Deal Statuses
    'pending_approval_l1': { type: 'pending', label: 'L1 Pending' },
    'pending_approval_l2': { type: 'pending', label: 'L2 Pending' },
    'pending_approval_l3': { type: 'pending', label: 'L3 Pending' },
    'approved': { type: 'success', label: 'Approved' },
    'rejected': { type: 'error', label: 'Rejected' },

    // Inventory Statuses
    'available': { type: 'success', label: 'Available' },
    'sold': { type: 'info', label: 'Sold' },
    'defective': { type: 'error', label: 'Defective' },
    'pdi_pending': { type: 'pending', label: 'PDI Pending' },
    'pdi_failed': { type: 'error', label: 'PDI Failed' },
    'in_transit': { type: 'info', label: 'In Transit' },
};

export function StatusBadge({ status, type, className }: StatusBadgeProps) {
    const config = statusMap[status.toLowerCase()] || { type: type || 'info', label: status };

    const typeStyles: Record<StatusType, string> = {
        success: 'bg-emerald-50 text-emerald-700 border-emerald-100',
        warning: 'bg-amber-50 text-amber-700 border-amber-100',
        error: 'bg-rose-50 text-rose-700 border-rose-100',
        info: 'bg-blue-50 text-blue-700 border-blue-100',
        pending: 'bg-indigo-50 text-indigo-700 border-indigo-100',
        active: 'bg-emerald-50 text-emerald-700 border-emerald-100',
        inactive: 'bg-gray-50 text-gray-700 border-gray-100',
    };

    return (
        <span className={cn(
            "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border uppercase tracking-wider",
            typeStyles[config.type],
            className
        )}>
            {config.label}
        </span>
    );
}
