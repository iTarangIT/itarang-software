'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
    Loader2, Search, Filter, CreditCard, AlertCircle,
    ChevronRight, Calendar, DollarSign, Clock, CheckCircle2,
    XCircle, ArrowUpDown
} from 'lucide-react';
import { useAuth } from '@/components/auth/AuthProvider';

type LoanFile = {
    id: string;
    borrower_name: string;
    co_borrower_name: string | null;
    loan_amount: string;
    emi_amount: string;
    tenure_months: number;
    disbursal_status: string;
    loan_status: string;
    total_paid: string;
    total_outstanding: string;
    overdue_amount: string;
    overdue_days: number;
    next_emi_date: string | null;
    created_at: string;
};

export default function LoanManagementPage() {
    const router = useRouter();
    const { user } = useAuth();
    const [loans, setLoans] = useState<LoanFile[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [filter, setFilter] = useState('all'); // all, active, overdue, closed, disbursed

    useEffect(() => {
        const fetchLoans = async () => {
            try {
                const res = await fetch(`/api/dealer/loans?filter=${filter}&search=${encodeURIComponent(searchQuery)}`);
                const data = await res.json();
                if (data.success) setLoans(data.data);
            } catch { /* silent */ }
            finally { setLoading(false); }
        };
        fetchLoans();
    }, [filter, searchQuery]);

    const getStatusColor = (status: string) => {
        const colors: Record<string, string> = {
            active: 'bg-green-50 text-green-700',
            closed: 'bg-gray-100 text-gray-600',
            defaulted: 'bg-red-50 text-red-700',
            pending: 'bg-yellow-50 text-yellow-700',
            disbursed: 'bg-blue-50 text-blue-700',
        };
        return colors[status] || 'bg-gray-100 text-gray-600';
    };

    const overdueLoans = loans.filter(l => l.overdue_days > 0);
    const totalOutstanding = loans.reduce((sum, l) => sum + parseFloat(l.total_outstanding || '0'), 0);
    const activeLoans = loans.filter(l => l.loan_status === 'active');

    return (
        <div className="min-h-screen bg-[#F8F9FB]">
            <div className="max-w-[1400px] mx-auto px-6 py-8">
                <header className="mb-8">
                    <h1 className="text-[28px] font-black text-gray-900 tracking-tight">Loan Management</h1>
                    <p className="text-sm text-gray-500 mt-1">Track all loan files, payments, and disbursals</p>
                </header>

                {/* KPI Cards */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                    <KPICard icon={<CreditCard className="w-5 h-5" />} label="Total Loan Files" value={loans.length.toString()} color="blue" />
                    <KPICard icon={<CheckCircle2 className="w-5 h-5" />} label="Active Loans" value={activeLoans.length.toString()} color="green" />
                    <KPICard icon={<DollarSign className="w-5 h-5" />} label="Total Outstanding" value={`₹${(totalOutstanding / 100000).toFixed(1)}L`} color="amber" />
                    <KPICard icon={<AlertCircle className="w-5 h-5" />} label="Overdue Loans" value={overdueLoans.length.toString()} color="red" />
                </div>

                {/* Filters */}
                <div className="flex items-center justify-between mb-6">
                    <div className="flex gap-2">
                        {['all', 'active', 'disbursed', 'overdue', 'closed'].map(f => (
                            <button
                                key={f}
                                onClick={() => setFilter(f)}
                                className={`px-4 py-2 rounded-xl text-sm font-bold transition-all capitalize ${filter === f ? 'bg-[#0047AB] text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-[#0047AB]'}`}
                            >
                                {f}
                            </button>
                        ))}
                    </div>
                    <div className="relative">
                        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                        <input
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            placeholder="Search by borrower name..."
                            className="pl-10 pr-4 py-2 border border-gray-200 rounded-xl text-sm w-64 outline-none focus:border-[#1D4ED8]"
                        />
                    </div>
                </div>

                {/* Table */}
                <div className="bg-white rounded-[20px] border border-gray-100 shadow-sm overflow-hidden">
                    {loading ? (
                        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-[#1D4ED8]" /></div>
                    ) : loans.length === 0 ? (
                        <div className="text-center py-20 text-gray-400">
                            <CreditCard className="w-12 h-12 mx-auto mb-3 opacity-30" />
                            <p className="font-bold">No loan files found</p>
                        </div>
                    ) : (
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-gray-100 bg-gray-50/50">
                                    <th className="text-left py-4 px-6 font-bold text-gray-500 text-xs uppercase">Borrower</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">Loan Amount</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">EMI</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">Outstanding</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">Overdue</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">Next EMI</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {loans.map(loan => (
                                    <tr key={loan.id} className="border-b border-gray-50 hover:bg-gray-50/50 cursor-pointer" onClick={() => router.push(`/dealer-portal/loans/management/${loan.id}`)}>
                                        <td className="py-4 px-6">
                                            <div className="font-bold text-gray-900">{loan.borrower_name}</div>
                                            {loan.co_borrower_name && <div className="text-xs text-gray-400">Co: {loan.co_borrower_name}</div>}
                                        </td>
                                        <td className="py-4 px-4 font-medium">₹{parseFloat(loan.loan_amount).toLocaleString()}</td>
                                        <td className="py-4 px-4 text-gray-600">₹{parseFloat(loan.emi_amount || '0').toLocaleString()}/mo</td>
                                        <td className="py-4 px-4 font-medium">₹{parseFloat(loan.total_outstanding || '0').toLocaleString()}</td>
                                        <td className="py-4 px-4">
                                            {loan.overdue_days > 0 ? (
                                                <span className="text-red-600 font-bold">₹{parseFloat(loan.overdue_amount).toLocaleString()} ({loan.overdue_days}d)</span>
                                            ) : <span className="text-green-600">-</span>}
                                        </td>
                                        <td className="py-4 px-4 text-gray-500 text-xs">{loan.next_emi_date ? new Date(loan.next_emi_date).toLocaleDateString() : '-'}</td>
                                        <td className="py-4 px-4">
                                            <span className={`px-3 py-1 rounded-full text-xs font-bold capitalize ${getStatusColor(loan.loan_status)}`}>
                                                {loan.loan_status}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        </div>
    );
}

function KPICard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
    const colorClasses: Record<string, string> = {
        blue: 'bg-blue-50 text-blue-600',
        green: 'bg-green-50 text-green-600',
        amber: 'bg-amber-50 text-amber-600',
        red: 'bg-red-50 text-red-600',
    };
    return (
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${colorClasses[color]}`}>{icon}</div>
            <p className="text-2xl font-black text-gray-900">{value}</p>
            <p className="text-xs font-medium text-gray-400 mt-1">{label}</p>
        </div>
    );
}
