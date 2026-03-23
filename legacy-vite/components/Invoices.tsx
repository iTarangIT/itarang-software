import React, { useState, useEffect } from 'react';
import { Download, MoreHorizontal, Search, AlertCircle, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Invoice } from '../types';

export const Invoices: React.FC = () => {
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');

    useEffect(() => {
        fetchInvoices();
    }, []);

    const fetchInvoices = async () => {
        try {
            setLoading(true);
            const { data, error } = await supabase
                .from('invoices')
                .select('*')
                .order('due_date', { ascending: true });

            if (error) throw error;
            setInvoices(data || []);
        } catch (error) {
            console.error('Error fetching invoices:', error);
        } finally {
            setLoading(false);
        }
    };

    const filtered = invoices.filter(inv =>
        inv.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        inv.oem.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const getStatusStyle = (status: string) => {
        switch (status) {
            case 'Paid': return 'bg-green-100 text-green-700';
            case 'Overdue': return 'bg-red-100 text-red-700';
            case 'Unpaid': return 'bg-yellow-100 text-yellow-700';
            default: return 'bg-gray-100 text-gray-700';
        }
    };

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Invoices</h1>
                    <p className="text-gray-500 text-sm mt-1">Manage payment status and reconciliations.</p>
                </div>
                <div className="flex gap-3">
                    <button className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-50 text-sm font-medium transition-colors">
                        <Download className="w-4 h-4" />
                        Download Report
                    </button>
                </div>
            </div>

            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="p-5 border-b border-gray-100 flex items-center justify-between gap-4">
                    <div className="relative flex-1 max-w-md">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <input
                            type="text"
                            placeholder="Search invoices..."
                            className="w-full pl-10 pr-4 py-2 bg-gray-50 border-none rounded-xl text-sm focus:ring-2 focus:ring-primary-100 focus:bg-white transition-all"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                    </div>
                </div>

                <div className="overflow-x-auto">
                    {loading ? (
                        <div className="flex items-center justify-center p-12 text-gray-500">
                            <Loader2 className="w-8 h-8 animate-spin mr-2" />
                            Loading invoices...
                        </div>
                    ) : (
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-gray-50/50 text-gray-500 text-xs font-semibold uppercase tracking-wider">
                                    <th className="px-6 py-4">Invoice ID</th>
                                    <th className="px-6 py-4">OEM</th>
                                    <th className="px-6 py-4">Order Ref</th>
                                    <th className="px-6 py-4 text-right">Amount</th>
                                    <th className="px-6 py-4">Due Date</th>
                                    <th className="px-6 py-4 text-center">Status</th>
                                    <th className="px-6 py-4 text-right">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {filtered.length === 0 ? (
                                    <tr>
                                        <td colSpan={7} className="px-6 py-8 text-center text-gray-400 text-sm">No invoices found.</td>
                                    </tr>
                                ) : filtered.map((inv) => (
                                    <tr key={inv.id} className="hover:bg-gray-50/50 transition-colors">
                                        <td className="px-6 py-4 font-medium text-gray-900">{inv.id}</td>
                                        <td className="px-6 py-4 text-sm text-gray-700">{inv.oem}</td>
                                        <td className="px-6 py-4 text-xs text-gray-500 font-mono">{inv.order_id}</td>
                                        <td className="px-6 py-4 text-right font-medium text-gray-900">₹{inv.amount.toLocaleString()}</td>
                                        <td className="px-6 py-4 text-sm text-gray-600">{inv.due_date}</td>
                                        <td className="px-6 py-4 text-center">
                                            <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${getStatusStyle(inv.status)}`}>
                                                {inv.status === 'Overdue' && <AlertCircle className="w-3 h-3" />}
                                                {inv.status}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <button className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-400 transition-colors">
                                                <MoreHorizontal className="w-4 h-4" />
                                            </button>
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
};