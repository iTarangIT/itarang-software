import React, { useState, useEffect } from 'react';
import { Download, MoreHorizontal, Search, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Order } from '../types';

export const Orders: React.FC = () => {
    const [orders, setOrders] = useState<Order[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');

    useEffect(() => {
        fetchOrders();
    }, []);

    const fetchOrders = async () => {
        try {
            setLoading(true);
            const { data, error } = await supabase
                .from('orders')
                .select('*')
                .order('date', { ascending: false });

            if (error) throw error;
            setOrders(data || []);
        } catch (error) {
            console.error('Error fetching orders:', error);
        } finally {
            setLoading(false);
        }
    };

    const filtered = orders.filter(o =>
        o.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        o.oem.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const getStatusStyle = (status: string) => {
        switch (status) {
            case 'Confirmed': return 'bg-green-100 text-green-700';
            case 'Delivered': return 'bg-blue-100 text-blue-700';
            case 'Sent': return 'bg-yellow-100 text-yellow-700';
            default: return 'bg-gray-100 text-gray-700';
        }
    };

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Orders</h1>
                    <p className="text-gray-500 text-sm mt-1">Track confirmed procurement orders from OEMs.</p>
                </div>
                <div className="flex gap-3">
                    <button className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-50 text-sm font-medium transition-colors">
                        <Download className="w-4 h-4" />
                        Export
                    </button>
                </div>
            </div>

            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="p-5 border-b border-gray-100 flex items-center justify-between gap-4">
                    <div className="relative flex-1 max-w-md">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <input
                            type="text"
                            placeholder="Search orders..."
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
                            Loading orders...
                        </div>
                    ) : (
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-gray-50/50 text-gray-500 text-xs font-semibold uppercase tracking-wider">
                                    <th className="px-6 py-4">Order ID</th>
                                    <th className="px-6 py-4">OEM</th>
                                    <th className="px-6 py-4">Provision Ref</th>
                                    <th className="px-6 py-4 text-center">Items</th>
                                    <th className="px-6 py-4 text-right">Amount</th>
                                    <th className="px-6 py-4 text-center">Status</th>
                                    <th className="px-6 py-4 text-right">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {filtered.length === 0 ? (
                                    <tr>
                                        <td colSpan={7} className="px-6 py-8 text-center text-gray-400 text-sm">No orders found.</td>
                                    </tr>
                                ) : filtered.map((order) => (
                                    <tr key={order.id} className="hover:bg-gray-50/50 transition-colors">
                                        <td className="px-6 py-4">
                                            <span className="font-medium text-gray-900">{order.id}</span>
                                            <div className="text-xs text-gray-400">{order.date}</div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-3">
                                                <div className="w-8 h-8 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center font-bold text-xs">
                                                    {order.oem.substring(0, 2).toUpperCase()}
                                                </div>
                                                <span className="text-sm text-gray-700 font-medium">{order.oem}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-sm text-gray-500 font-mono text-xs">{order.provision_id}</td>
                                        <td className="px-6 py-4 text-center">
                                            <span className="px-2 py-1 bg-gray-100 rounded-lg text-xs font-semibold text-gray-700">{order.items}</span>
                                        </td>
                                        <td className="px-6 py-4 text-right font-medium text-gray-900">₹{order.amount.toLocaleString()}</td>
                                        <td className="px-6 py-4 text-center">
                                            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${getStatusStyle(order.status)}`}>
                                                {order.status}
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