'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
    FileCheck, CreditCard, ArrowRight, Landmark,
    BarChart3, Smartphone, BellRing, TrendingUp,
    Clock, CheckCircle2, AlertTriangle, Loader2,
} from 'lucide-react';

type FacilitationStats = {
    total: number;
    fee_pending: number;
    under_validation: number;
    validation_passed: number;
    fee_paid: number;
};

type LoanStats = {
    totalFiles: number;
    activeLoans: number;
    overdueLoans: number;
    totalDisbursed: number;
};

export default function LoansIndexPage() {
    const [facStats, setFacStats] = useState<FacilitationStats | null>(null);
    const [loanStats, setLoanStats] = useState<LoanStats | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        Promise.allSettled([
            fetch('/api/dealer/loan-facilitation/stats', { credentials: 'include' })
                .then(r => r.json())
                .then(d => { if (d.success) setFacStats(d.data); }),
            fetch('/api/dealer/loans?limit=0', { credentials: 'include' })
                .then(r => r.json())
                .then(d => {
                    if (d.success) {
                        const files = d.data || [];
                        setLoanStats({
                            totalFiles: files.length,
                            activeLoans: files.filter((f: any) => f.loan_status === 'active').length,
                            overdueLoans: files.filter((f: any) => (f.overdue_days || 0) > 0).length,
                            totalDisbursed: files.filter((f: any) => f.disbursal_status === 'disbursed').length,
                        });
                    }
                }),
        ]).finally(() => setLoading(false));
    }, []);

    return (
        <div className="space-y-8">
            <div>
                <h1 className="text-2xl font-bold text-gray-900">Loan Overview</h1>
                <p className="mt-1 text-gray-500">Manage loan facilitation queue and active loan files from one place.</p>
            </div>

            {/* Two main cards */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                {/* Loan Facilitation Card */}
                <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
                    <div className="p-6 border-b border-gray-100">
                        <div className="flex items-start justify-between">
                            <div className="flex items-start gap-4">
                                <div className="rounded-xl bg-indigo-50 p-3 text-indigo-600">
                                    <FileCheck className="h-6 w-6" />
                                </div>
                                <div>
                                    <h2 className="text-lg font-bold text-gray-900">Loan Facilitation</h2>
                                    <p className="text-sm text-gray-500 mt-0.5">Process documents & pay facilitation fees</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="p-6">
                        {loading ? (
                            <div className="flex items-center gap-2 text-sm text-gray-400">
                                <Loader2 className="h-4 w-4 animate-spin" /> Loading...
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 gap-3">
                                <MiniStat icon={<Clock className="h-4 w-4" />} label="In Queue" value={facStats?.total ?? 0} tone="blue" />
                                <MiniStat icon={<AlertTriangle className="h-4 w-4" />} label="Fee Pending" value={facStats?.fee_pending ?? 0} tone="red" />
                                <MiniStat icon={<CheckCircle2 className="h-4 w-4" />} label="Validated" value={facStats?.validation_passed ?? 0} tone="green" />
                                <MiniStat icon={<CheckCircle2 className="h-4 w-4" />} label="Fee Paid" value={facStats?.fee_paid ?? 0} tone="emerald" />
                            </div>
                        )}

                        <Link
                            href="/dealer-portal/loans/facilitation"
                            className="mt-5 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold px-4 py-3 transition-colors"
                        >
                            Open Facilitation Queue <ArrowRight className="h-4 w-4" />
                        </Link>
                    </div>
                </div>

                {/* Loan Management Card */}
                <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
                    <div className="p-6 border-b border-gray-100">
                        <div className="flex items-start justify-between">
                            <div className="flex items-start gap-4">
                                <div className="rounded-xl bg-green-50 p-3 text-green-600">
                                    <CreditCard className="h-6 w-6" />
                                </div>
                                <div>
                                    <h2 className="text-lg font-bold text-gray-900">Loan Management</h2>
                                    <p className="text-sm text-gray-500 mt-0.5">Track active loans, EMIs & disbursals</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="p-6">
                        {loading ? (
                            <div className="flex items-center gap-2 text-sm text-gray-400">
                                <Loader2 className="h-4 w-4 animate-spin" /> Loading...
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 gap-3">
                                <MiniStat icon={<CreditCard className="h-4 w-4" />} label="Total Files" value={loanStats?.totalFiles ?? 0} tone="blue" />
                                <MiniStat icon={<TrendingUp className="h-4 w-4" />} label="Active" value={loanStats?.activeLoans ?? 0} tone="green" />
                                <MiniStat icon={<CheckCircle2 className="h-4 w-4" />} label="Disbursed" value={loanStats?.totalDisbursed ?? 0} tone="emerald" />
                                <MiniStat icon={<AlertTriangle className="h-4 w-4" />} label="Overdue" value={loanStats?.overdueLoans ?? 0} tone="red" />
                            </div>
                        )}

                        <Link
                            href="/dealer-portal/loans/management"
                            className="mt-5 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-green-600 hover:bg-green-700 text-white text-sm font-semibold px-4 py-3 transition-colors"
                        >
                            Open Loan Management <ArrowRight className="h-4 w-4" />
                        </Link>
                    </div>
                </div>
            </div>

            {/* Future Roadmap */}
            <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
                <div className="p-6 border-b border-gray-100">
                    <h2 className="text-lg font-bold text-gray-900">Loan Module Roadmap</h2>
                    <p className="text-sm text-gray-500 mt-0.5">Upcoming features planned for the loan workflow</p>
                </div>
                <div className="p-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <RoadmapItem
                            icon={<Landmark className="h-5 w-5" />}
                            title="NBFC/Bank Integration"
                            description="Direct API integration with lending partners for automated loan application submission and real-time approval status."
                            phase="Phase 2"
                        />
                        <RoadmapItem
                            icon={<BarChart3 className="h-5 w-5" />}
                            title="EMI Tracking Dashboard"
                            description="Real-time EMI payment tracking with automated reminders, payment history, and outstanding balance calculations."
                            phase="Phase 2"
                        />
                        <RoadmapItem
                            icon={<Smartphone className="h-5 w-5" />}
                            title="Customer Self-Serve Portal"
                            description="Customers can check loan status, upload documents, and make payments through a dedicated mobile-friendly portal."
                            phase="Phase 3"
                        />
                        <RoadmapItem
                            icon={<BellRing className="h-5 w-5" />}
                            title="Collection Workflow"
                            description="Automated overdue alerts, escalation rules, and collection agent assignment with WhatsApp/SMS notifications."
                            phase="Phase 3"
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}

function MiniStat({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone: 'blue' | 'red' | 'green' | 'emerald' }) {
    const colors = {
        blue: 'bg-blue-50 text-blue-700',
        red: 'bg-red-50 text-red-700',
        green: 'bg-green-50 text-green-700',
        emerald: 'bg-emerald-50 text-emerald-700',
    };
    return (
        <div className={`flex items-center gap-3 rounded-xl px-4 py-3 ${colors[tone]}`}>
            {icon}
            <div>
                <div className="text-xl font-extrabold leading-tight">{value}</div>
                <div className="text-[10px] font-semibold uppercase tracking-wider opacity-70">{label}</div>
            </div>
        </div>
    );
}

function RoadmapItem({ icon, title, description, phase }: { icon: React.ReactNode; title: string; description: string; phase: string }) {
    return (
        <div className="rounded-xl border border-gray-100 bg-gray-50 p-5">
            <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                    <div className="rounded-lg bg-white p-2 text-gray-600 shadow-sm">{icon}</div>
                    <h3 className="font-bold text-gray-900">{title}</h3>
                </div>
                <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-700">
                    {phase}
                </span>
            </div>
            <p className="mt-3 text-sm text-gray-600 leading-relaxed">{description}</p>
        </div>
    );
}
