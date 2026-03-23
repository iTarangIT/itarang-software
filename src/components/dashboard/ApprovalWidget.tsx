'use client';

import { useState, useEffect } from 'react';
import { ShieldCheck, ArrowRight } from 'lucide-react';
import Link from 'next/link';

export default function ApprovalWidget() {
    const [count, setCount] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchCount = async () => {
            try {
                const res = await fetch('/api/approvals/count');
                const data = await res.json();
                setCount(data.data.count);
            } catch (err) {
                console.error('Failed to fetch approval count:', err);
            } finally {
                setLoading(false);
            }
        };

        fetchCount();
    }, []);

    if (loading) return (
        <div className="p-6 bg-white rounded-2xl border border-gray-100 shadow-sm animate-pulse">
            <div className="w-10 h-10 bg-gray-100 rounded-xl mb-4"></div>
            <div className="h-6 w-24 bg-gray-100 rounded mb-2"></div>
            <div className="h-4 w-32 bg-gray-100 rounded"></div>
        </div>
    );

    if (count === null || count === 0) return null;

    return (
        <Link href="/approvals" className="block group">
            <div className="p-6 bg-brand-50 rounded-2xl border border-brand-100 shadow-sm group-hover:shadow-md transition-all relative overflow-hidden">
                <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:scale-110 transition-transform">
                    <ShieldCheck className="w-24 h-24 text-brand-600" />
                </div>

                <div className="relative z-10">
                    <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center mb-4 shadow-sm">
                        <ShieldCheck className="w-5 h-5 text-brand-600" />
                    </div>

                    <div className="flex items-baseline gap-2 mb-1">
                        <h3 className="text-3xl font-extrabold text-brand-900">{count}</h3>
                        <p className="text-sm font-medium text-brand-600">Action Items</p>
                    </div>

                    <p className="text-sm text-brand-700/70 mb-4">
                        Pending your approval across Deals and Procurement Orders.
                    </p>

                    <div className="flex items-center text-xs font-bold text-brand-600 uppercase tracking-wider">
                        View Approvals <ArrowRight className="w-3 h-3 ml-1 group-hover:translate-x-1 transition-transform" />
                    </div>
                </div>
            </div>
        </Link>
    );
}
