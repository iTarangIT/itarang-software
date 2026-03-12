'use client';

import Link from 'next/link';
import { PlusCircle, Search, Filter, Loader2 } from 'lucide-react';
import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function DealerLeadsContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [leads, setLeads] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('All');
    const [typeFilter, setTypeFilter] = useState('All');

    const fetchLeads = async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (search) params.append('search', search);
            if (statusFilter !== 'All') params.append('status', statusFilter);
            if (typeFilter !== 'All') params.append('type', typeFilter);

            const res = await fetch(`/api/dealer/leads?${params.toString()}`);
            const data = await res.json();
            if (data.success) {
                setLeads(data.data);
            }
        } catch (error) {
            console.error('Failed to fetch leads', error);
        } finally {
            setLoading(false);
        }
    };

    // Debounce search
    useEffect(() => {
        const timer = setTimeout(() => {
            fetchLeads();
        }, 500);
        return () => clearTimeout(timer);
    }, [search, statusFilter, typeFilter]);

    // Highlight new lead
    const newLeadId = searchParams.get('new');

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Lead Management</h1>
                    <p className="text-gray-500 text-sm">Track and manage your customer pipeline</p>
                </div>
                <Link href="/dealer-portal/leads/new" className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white font-medium rounded-lg hover:bg-brand-700 transition-colors shadow-sm">
                    <PlusCircle className="w-5 h-5" />
                    New Lead
                </Link>
            </div>

            {/* Filters */}
            <div className="flex flex-col sm:flex-row gap-4 p-4 bg-white rounded-xl border border-gray-100 shadow-sm">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search by name, phone..."
                        className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent text-sm"
                    />
                </div>
                <div className="flex gap-2">
                    <select
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                        className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    >
                        <option>All</option>
                        <option value="new">New</option>
                        <option value="contacted">Contacted</option>
                        <option value="qualified">Qualified</option>
                    </select>
                    <select
                        value={typeFilter}
                        onChange={(e) => setTypeFilter(e.target.value)}
                        className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    >
                        <option>All</option>
                        <option value="hot">Hot</option>
                        <option value="warm">Warm</option>
                        <option value="cold">Cold</option>
                    </select>
                </div>
            </div>

            {/* Table */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden min-h-[300px]">
                {loading ? (
                    <div className="flex items-center justify-center h-48">
                        <Loader2 className="w-8 h-8 text-brand-600 animate-spin" />
                    </div>
                ) : leads.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-48 text-gray-500">
                        <Filter className="w-8 h-8 mb-2 opacity-50" />
                        <p>No leads found matching your criteria</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-gray-50 border-b border-gray-200 text-xs uppercase text-gray-500 font-semibold tracking-wider">
                                    <th className="px-6 py-4">Customer</th>
                                    <th className="px-6 py-4">Status</th>
                                    <th className="px-6 py-4">Interest</th>
                                    <th className="px-6 py-4">Loan Amount</th>
                                    <th className="px-6 py-4">Created</th>
                                    <th className="px-6 py-4 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100 text-sm">
                                {leads.map((lead: any) => (
                                    <tr key={lead.id} className={`hover:bg-gray-50 transition-colors group ${newLeadId === lead.id ? 'bg-brand-50' : ''}`}>
                                        <td className="px-6 py-4">
                                            <div className="font-medium text-gray-900">{lead.owner_name}</div>
                                            <div className="text-gray-500 text-xs">{lead.owner_contact}</div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize
                                                ${lead.lead_status === 'new' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-800'}
                                            `}>
                                                {lead.lead_status}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className="inline-flex items-center gap-1.5 capitalize">
                                                <span className={`w-2 h-2 rounded-full 
                                                    ${lead.interest_level === 'hot' ? 'bg-red-500' : lead.interest_level === 'warm' ? 'bg-yellow-500' : 'bg-blue-500'}
                                                `}></span>
                                                {lead.interest_level}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-gray-600">
                                            {lead.loan_amount ? `₹${Number(lead.loan_amount).toLocaleString()}` : '-'}
                                        </td>
                                        <td className="px-6 py-4 text-gray-500">
                                            {new Date(lead.created_at).toLocaleDateString()}
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <button className="text-brand-600 hover:text-brand-800 font-medium text-xs opacity-0 group-hover:opacity-100 transition-opacity">
                                                View Details
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

export default function DealerLeadsPage() {
    return (
        <Suspense fallback={
            <div className="flex flex-col items-center justify-center p-8 h-96">
                <Loader2 className="w-8 h-8 text-brand-600 animate-spin mb-4" />
                <p className="text-gray-500">Loading leads...</p>
            </div>
        }>
            <DealerLeadsContent />
        </Suspense>
    );
}
