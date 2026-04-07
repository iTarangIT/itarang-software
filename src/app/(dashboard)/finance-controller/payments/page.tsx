import { db } from '@/lib/db';
import { orders } from '@/lib/db/schema';
import { desc } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { IndianRupee, CheckCircle2, Clock, AlertCircle } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function FinancePaymentsPage() {
    await requireAuth();

    const allOrders = await db.select()
        .from(orders)
        .orderBy(desc(orders.created_at));

    const paid = allOrders.filter(o => o.payment_status === 'paid');
    const unpaid = allOrders.filter(o => o.payment_status === 'unpaid');
    const partial = allOrders.filter(o => o.payment_status === 'partial');
    const totalReceived = allOrders.reduce((sum, o) => sum + Number(o.payment_amount || 0), 0);

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
            <div className="mb-8">
                <h1 className="text-3xl font-black text-gray-900">Payment Tracking</h1>
                <p className="text-sm text-gray-500 mt-1 uppercase tracking-widest font-bold">Monitor order payments and receivables</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Total Received</p>
                    <p className="text-2xl font-black text-green-600">{totalReceived.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Paid</p>
                    <p className="text-2xl font-black text-green-600">{paid.length}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Partial</p>
                    <p className="text-2xl font-black text-orange-600">{partial.length}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Unpaid</p>
                    <p className="text-2xl font-black text-red-600">{unpaid.length}</p>
                </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Order ID</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Total Amount</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Paid Amount</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Mode</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {allOrders.map((order) => (
                            <tr key={order.id} className="hover:bg-gray-50 transition-colors">
                                <td className="px-6 py-4 whitespace-nowrap">
                                    <Link href={`/orders/${order.id}`} className="text-sm font-bold text-blue-600 hover:underline">{order.id}</Link>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-900">
                                    {Number(order.total_amount).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                                    {Number(order.payment_amount).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">{order.payment_mode || '—'}</td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                    <span className={`px-3 py-1 rounded-full text-xs font-bold ${order.payment_status === 'paid' ? 'bg-green-100 text-green-700' : order.payment_status === 'partial' ? 'bg-orange-100 text-orange-700' : 'bg-red-100 text-red-700'}`}>
                                        {order.payment_status.toUpperCase()}
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {allOrders.length === 0 && (
                    <div className="p-12 text-center text-gray-500 bg-gray-50/50">
                        <IndianRupee className="w-12 h-12 text-gray-200 mx-auto mb-3" />
                        <p className="font-medium">No orders found.</p>
                        <p className="text-sm">Payment records will appear here once orders are created.</p>
                    </div>
                )}
            </div>
        </div>
    );
}
