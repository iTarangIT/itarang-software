import React from 'react';

interface SkeletonProps {
    className?: string;
    variant?: 'text' | 'rect' | 'circle';
}

export const Skeleton: React.FC<SkeletonProps> = ({ className = '', variant = 'rect' }) => {
    const baseClasses = 'animate-pulse bg-gray-200';
    const variantClasses = {
        text: 'h-4 w-full rounded',
        rect: 'h-24 w-full rounded-xl',
        circle: 'h-12 w-12 rounded-full',
    };

    return <div className={`${baseClasses} ${variantClasses[variant]} ${className}`} />;
};

export const KPISkeleton = () => (
    <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm space-y-4">
        <div className="flex items-center gap-3">
            <Skeleton variant="circle" className="w-10 h-10" />
            <Skeleton variant="text" className="w-24" />
        </div>
        <Skeleton variant="text" className="h-8 w-16" />
        <Skeleton variant="text" className="w-32" />
    </div>
);

export const TableSkeleton = ({ rows = 5 }: { rows?: number }) => (
    <div className="space-y-4">
        {[...Array(rows)].map((_, i) => (
            <div key={i} className="flex gap-4 p-4 border-b border-gray-50 items-center">
                <Skeleton variant="circle" className="w-8 h-8" />
                <div className="flex-1 space-y-2">
                    <Skeleton variant="text" className="w-1/3" />
                    <Skeleton variant="text" className="w-1/4" />
                </div>
                <Skeleton variant="text" className="w-20" />
            </div>
        ))}
    </div>
);
