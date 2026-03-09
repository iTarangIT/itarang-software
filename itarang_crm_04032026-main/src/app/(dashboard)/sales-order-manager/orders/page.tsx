import { db } from '@/lib/db';
import { orders } from '@/lib/db/schema';
import { desc } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { ShoppingCart, FileText, IndianRupee, Truck, CheckCircle2, AlertCircle } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const STATUS_MAP: Record<string, { label: string, color: string }> = {
    pi_awaited: { label: 'PI Awaited', color: 'bg-yellow-100 text-yellow-800' },
    pi_approval_pending: { label: 'PI Approval Pending', color: 'bg-orange-100 text-orange-800' },
    pi_approved: { label: 'PI Approved', color: 'bg-blue-100 text-blue-800' },
    payment_made: { label: 'Payment Made', color: 'bg-green-100 text-green-800' },
    in_transit: { label: 'In Transit', color: 'bg-purple-100 text-purple-800' },
    delivered: { label: 'Delivered', color: 'bg-gray-100 text-gray-800' },
    cancelled: { label: 'Cancelled', color: 'bg-red-100 text-red-800' },
};

export default async function SOMOrdersPage() {
    await requireAuth();

    const allOrders = await db.select()
        .from(orders)
        .orderBy(desc(orders.created_at));

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
            <div className="mb-8">
                <h1 className="text-3xl font-black text-gray-900">Order Management</h1>
                <p className="text-sm text-gray-500 mt-1 uppercase tracking-widest font-bold">Track procurement orders and deliveries</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Total Orders</p>
                    <p className="text-3xl font-black text-gray-900">{allOrders.length}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">In Transit</p>
                    <p className="text-3xl font-black text-purple-600">{allOrders.filter(o => o.delivery_status === 'in_transit').length}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Delivered</p>
                    <p className="text-3xl font-black text-green-600">{allOrders.filter(o => o.delivery_status === 'delivered').length}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Pending</p>
                    <p className="text-3xl font-black text-orange-600">{allOrders.filter(o => o.delivery_status === 'pending').length}</p>
                </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Order ID</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Provision</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Payment</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {allOrders.map((order) => {
                            const status = STATUS_MAP[order.order_status] || STATUS_MAP.pi_awaited;
                            return (
                                <tr key={order.id} className="hover:bg-gray-50 transition-colors">
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-900">{order.id}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-blue-600 font-medium">{order.provision_id}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-900">
                                        {Number(order.total_amount).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${order.payment_status === 'paid' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                                            {order.payment_status.toUpperCase()}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <span className={`px-3 py-1 rounded-full text-xs font-bold ${status.color}`}>
                                            {status.label.toUpperCase()}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-right">
                                        <Link href={`/orders/${order.id}`} className="text-sm font-bold text-blue-600 hover:underline">Manage</Link>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                {allOrders.length === 0 && (
                    <div className="p-12 text-center text-gray-500 bg-gray-50/50">
                        <ShoppingCart className="w-12 h-12 text-gray-200 mx-auto mb-3" />
                        <p className="font-medium">No orders found.</p>
                    </div>
                )}
            </div>
        </div>
    );
}
