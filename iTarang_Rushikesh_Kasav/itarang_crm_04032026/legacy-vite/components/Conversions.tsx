import React, { useState, useEffect } from 'react';
import { MoreHorizontal, Search, CheckCircle, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Conversion } from '../types';

export const Conversions: React.FC = () => {
    const [conversions, setConversions] = useState<Conversion[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');

    useEffect(() => {
        fetchConversions();
    }, []);

    const fetchConversions = async () => {
        try {
            setLoading(true);
            const { data, error } = await supabase
                .from('conversions')
                .select('*')
                .order('date', { ascending: false });

            if (error) throw error;
            setConversions(data || []);
        } catch (error) {
            console.error('Error fetching conversions:', error);
        } finally {
            setLoading(false);
        }
    };

    const filtered = conversions.filter(c =>
        c.lead_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        c.source.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const totalValue = conversions.reduce((sum, c) => sum + c.value, 0);

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Conversions</h1>
                    <p className="text-gray-500 text-sm mt-1">Track successful sales and revenue attribution.</p>
                </div>
                <div className="flex gap-3">
                    <div className="bg-white border border-gray-200 px-4 py-2 rounded-xl flex items-center gap-2 shadow-sm">
                        <span className="text-sm text-gray-500">Total Value:</span>
                        <span className="text-sm font-bold text-gray-900">₹{totalValue.toLocaleString()}</span>
                    </div>
                </div>
            </div>

            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="p-5 border-b border-gray-100 flex items-center justify-between gap-4">
                    <div className="relative flex-1 max-w-md">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <input
                            type="text"
                            placeholder="Search conversions..."
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
                            Loading conversions...
                        </div>
                    ) : (
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-gray-50/50 text-gray-500 text-xs font-semibold uppercase tracking-wider">
                                    <th className="px-6 py-4">Conversion ID</th>
                                    <th className="px-6 py-4">Lead Name</th>
                                    <th className="px-6 py-4">Product</th>
                                    <th className="px-6 py-4 text-center">Source</th>
                                    <th className="px-6 py-4 text-right">Value</th>
                                    <th className="px-6 py-4">Date</th>
                                    <th className="px-6 py-4 text-right">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {filtered.length === 0 ? (
                                    <tr>
                                        <td colSpan={7} className="px-6 py-8 text-center text-gray-400 text-sm">No conversions found.</td>
                                    </tr>
                                ) : filtered.map((conv) => (
                                    <tr key={conv.id} className="hover:bg-gray-50/50 transition-colors">
                                        <td className="px-6 py-4 font-medium text-gray-900">{conv.id}</td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-2">
                                                <CheckCircle className="w-4 h-4 text-green-500" />
                                                <span className="text-gray-900 font-medium">{conv.lead_name}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-sm text-gray-600">{conv.product}</td>
                                        <td className="px-6 py-4 text-center">
                                            <span className={`inline-flex px-2 py-1 rounded-md text-xs font-medium 
                                        ${conv.source === 'Bolna AI' ? 'bg-purple-100 text-purple-700 border border-purple-200' : 'bg-gray-100 text-gray-700'}`}>
                                                {conv.source}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-right font-bold text-gray-900">₹{conv.value.toLocaleString()}</td>
                                        <td className="px-6 py-4 text-sm text-gray-500">{conv.date}</td>
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