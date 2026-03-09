import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../auth/AuthProvider';
import { Package, Clock, CheckCircle, Truck, Loader2, FileText } from 'lucide-react';

interface Order {
    id: string;
    provision_id: string;
    oem: string;
    amount: number;
    status: string;
    date: string;
    items: number;
}

export const DealerDashboard: React.FC = () => {
    const { user } = useAuth();
    const [orders, setOrders] = useState<Order[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (user) {
            fetchDealerOrders();
        }
    }, [user]);

    async function fetchDealerOrders() {
        try {
            setLoading(true);
            const { data } = await supabase
                .from('orders')
                .select('*')
                .eq('dealer_id', user?.id)
                .order('date', { ascending: false });

            setOrders(data || []);
        } catch (error) {
            console.error('Error fetching dealer orders:', error);
        } finally {
            setLoading(false);
        }
    }

    const stats = {
        total: orders.length,
        pending: orders.filter(o => o.status === 'Sent').length,
        confirmed: orders.filter(o => o.status === 'Confirmed').length,
        delivered: orders.filter(o => o.status === 'Delivered').length,
    };

    const getStatusIcon = (status: string) => {
        switch (status) {
            case 'Draft': return <FileText className="w-5 h-5 text-gray-600" />;
            case 'Sent': return <Clock className="w-5 h-5 text-amber-600" />;
            case 'Confirmed': return <CheckCircle className="w-5 h-5 text-blue-600" />;
            case 'Delivered': return <Truck className="w-5 h-5 text-green-600" />;
            default: return <Package className="w-5 h-5 text-gray-600" />;
        }
    };

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'Draft': return 'bg-gray-100 text-gray-700';
            case 'Sent': return 'bg-amber-100 text-amber-700';
            case 'Confirmed': return 'bg-blue-100 text-blue-700';
            case 'Delivered': return 'bg-green-100 text-green-700';
            default: return 'bg-gray-100 text-gray-700';
        }
    };

    if (loading) {
        return (
            <div className="space-y-6 animate-fade-in">
                <div className="space-y-2">
                    <div className="h-8 w-64 bg-slate-200 rounded-lg animate-pulse" />
                    <div className="h-4 w-48 bg-slate-100 rounded animate-pulse" />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                    {[1, 2, 3, 4].map(i => (
                        <div key={i} className="h-32 bg-slate-50 rounded-2xl border border-slate-100 animate-pulse" />
                    ))}
                </div>
                <div className="h-64 bg-slate-50 rounded-2xl border border-slate-100 animate-pulse" />
            </div>
        );
    }

    return (
        <div className="space-y-6 animate-fade-in">
            <div>
                <h1 className="text-2xl font-bold text-gray-900">Dealer Dashboard</h1>
                <p className="text-gray-500 text-sm mt-1">Track your orders and delivery status</p>
            </div>

            {/* Focal Point KPI Cards (SOP #2.2) */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                {[
                    { label: 'Total Orders', value: stats.total, icon: Package, color: 'text-slate-500', sub: 'Historical total' },
                    { label: 'Processing', value: stats.pending, icon: Clock, color: 'text-amber-500', sub: 'Awaiting OEM' },
                    { label: 'Confirmed', value: stats.confirmed, icon: CheckCircle, color: 'text-blue-500', sub: 'Payment verified' },
                    { label: 'Delivered', value: stats.delivered, icon: Truck, color: 'text-green-500', sub: 'In your hands' },
                ].map((stat, i) => (
                    <div key={i} className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm hover:shadow-md transition-all group">
                        <div className="flex items-center justify-between mb-4">
                            <div className="p-2 bg-slate-50 rounded-lg text-slate-400 group-hover:text-primary-600 transition-colors">
                                <stat.icon className={`w-5 h-5 ${stat.color}`} />
                            </div>
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Status</span>
                        </div>
                        <p className="text-3xl font-black text-slate-900">{stat.value}</p>
                        <p className="text-xs text-slate-500 mt-1">{stat.sub}</p>
                    </div>
                ))}
            </div>

            {/* Orders Table */}
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden transition-all hover:shadow-md">
                <div className="p-6 border-b border-slate-50 flex justify-between items-center">
                    <h2 className="text-lg font-black text-slate-800 tracking-tight">Order History</h2>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead className="bg-slate-50 border-b border-slate-100">
                            <tr>
                                <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Identity</th>
                                <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Details</th>
                                <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Financials</th>
                                <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Status Feed</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                            {orders.length === 0 ? (
                                <tr>
                                    <td colSpan={4} className="px-6 py-16 text-center">
                                        <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4">
                                            <Package className="w-8 h-8 text-slate-200" />
                                        </div>
                                        <p className="text-slate-500 font-bold">No Records Found</p>
                                        <p className="text-xs text-slate-400 mt-1">Your supply chain activities will appear here</p>
                                    </td>
                                </tr>
                            ) : (
                                orders.map(order => (
                                    <tr key={order.id} className="hover:bg-slate-50/50 transition-colors group">
                                        <td className="px-6 py-5">
                                            <div className="font-bold text-slate-900 group-hover:text-primary-600 transition-colors">{order.id}</div>
                                            <div className="text-[10px] text-slate-400 font-mono mt-0.5">{order.provision_id}</div>
                                        </td>
                                        <td className="px-6 py-5">
                                            <div className="text-sm font-semibold text-slate-700">{order.oem}</div>
                                            <div className="text-[10px] text-slate-400 mt-1">
                                                {new Date(order.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} • {order.items} Items
                                            </div>
                                        </td>
                                        <td className="px-6 py-5">
                                            <div className="text-sm font-black text-slate-900">₹{(order.amount / 100000).toFixed(1)}L</div>
                                            <div className="text-[10px] text-slate-400 mt-0.5 uppercase tracking-tighter">Gross Amount</div>
                                        </td>
                                        <td className="px-6 py-5">
                                            <div className="flex items-center gap-4">
                                                <div className="flex items-center gap-0.5">
                                                    {[1, 2, 3, 4].map(step => (
                                                        <div
                                                            key={step}
                                                            className={`h-1 w-4 rounded-full transition-all duration-500 ${(order.status === 'Sent' && step === 1) ||
                                                                (order.status === 'Confirmed' && step <= 2) ||
                                                                (order.status === 'In Transit' && step <= 3) ||
                                                                (order.status === 'Delivered' && step <= 4)
                                                                ? 'bg-primary-600 shadow-[0_0_8px_rgba(59,130,246,0.3)]' : 'bg-slate-100'
                                                                }`}
                                                        />
                                                    ))}
                                                </div>
                                                <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-widest ${getStatusColor(order.status)}`}>
                                                    {order.status}
                                                </span>
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* High-Fidelity Active Tracking (v2.1) */}
            {orders.filter(o => o.status !== 'Delivered').length > 0 && (
                <div className="bg-slate-900 text-white rounded-2xl border border-slate-800 shadow-2xl p-8 relative overflow-hidden group">
                    <div className="absolute right-0 top-0 p-12 opacity-5 pointer-events-none group-hover:scale-110 transition-transform duration-700">
                        <Truck className="w-48 h-48" />
                    </div>

                    <div className="relative z-10">
                        <div className="flex items-center gap-3 mb-8">
                            <div className="w-10 h-10 bg-primary-600 rounded-xl flex items-center justify-center shadow-lg shadow-primary-500/20">
                                <Clock className="w-5 h-5" />
                            </div>
                            <div>
                                <h2 className="text-xl font-black tracking-tight">Active Supply Chain</h2>
                                <p className="text-xs text-slate-400 font-medium">Real-time status of your in-flight orders</p>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                            {orders.filter(o => o.status !== 'Delivered').slice(0, 3).map(order => (
                                <div key={order.id} className="bg-slate-800/50 rounded-2xl p-6 border border-slate-700/50 hover:border-primary-500/50 transition-all">
                                    <div className="flex justify-between items-start mb-4">
                                        <div className="font-bold text-slate-200">{order.id}</div>
                                        <span className="text-[10px] font-bold text-primary-400 uppercase tracking-widest">{order.status}</span>
                                    </div>
                                    <p className="text-sm text-slate-400 mb-6">{order.oem} • {order.items} Units</p>

                                    <div className="space-y-4">
                                        <div className="flex justify-between text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                                            <span>Processing</span>
                                            <span>Transit</span>
                                            <span>Delivery</span>
                                        </div>
                                        <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden flex gap-1 p-0.5">
                                            <div className={`h-full rounded-full transition-all duration-1000 ${order.status !== 'Sent' ? 'bg-primary-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]' : 'bg-primary-500/50'} w-1/3`} />
                                            <div className={`h-full rounded-full transition-all duration-1000 ${order.status === 'In Transit' || order.status === 'Delivered' ? 'bg-primary-500' : 'bg-slate-700'} w-1/3`} />
                                            <div className={`h-full rounded-full transition-all duration-1000 ${order.status === 'Delivered' ? 'bg-primary-500' : 'bg-slate-700'} w-1/3`} />
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
