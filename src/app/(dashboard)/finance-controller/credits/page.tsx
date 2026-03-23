import { db } from '@/lib/db';
import { orders, deals, leads } from '@/lib/db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { CreditCard, AlertTriangle } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function FinanceCreditsPage() {
    await requireAuth();

    const creditOrders = await db.select()
        .from(orders)
        .where(eq(orders.payment_term, 'credit'))
        .orderBy(desc(orders.created_at));

    const totalOutstanding = creditOrders
        .filter(o => o.payment_status !== 'paid')
        .reduce((sum, o) => sum + (Number(o.total_amount) - Number(o.payment_amount)), 0);

    const overdueCount = creditOrders.filter(o => {
        if (o.payment_status === 'paid') return false;
        if (!o.expected_delivery_date) return false;
        const dueDate = new Date(o.expected_delivery_date);
        dueDate.setDate(dueDate.getDate() + (o.credit_period_days || 30));
        return new Date() > dueDate;
    }).length;

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
            <div className="mb-8">
                <h1 className="text-3xl font-black text-gray-900">Credit & Receivables</h1>
                <p className="text-sm text-gray-500 mt-1 uppercase tracking-widest font-bold">Manage credit orders and outstanding receivables</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Outstanding</p>
                    <p className="text-3xl font-black text-red-600">{totalOutstanding.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Credit Orders</p>
                    <p className="text-3xl font-black text-blue-600">{creditOrders.length}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Overdue</p>
                    <p className="text-3xl font-black text-orange-600">{overdueCount}</p>
                </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Order ID</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Total</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Outstanding</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Credit Period</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {creditOrders.map((order) => {
                            const outstanding = Number(order.total_amount) - Number(order.payment_amount);
                            return (
                                <tr key={order.id} className="hover:bg-gray-50 transition-colors">
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-900">{order.id}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                                        {Number(order.total_amount).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-red-600">
                                        {outstanding.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">{order.credit_period_days || 30} days</td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <span className={`px-3 py-1 rounded-full text-xs font-bold ${order.payment_status === 'paid' ? 'bg-green-100 text-green-700' : order.payment_status === 'partial' ? 'bg-orange-100 text-orange-700' : 'bg-red-100 text-red-700'}`}>
                                            {order.payment_status.toUpperCase()}
                                        </span>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                {creditOrders.length === 0 && (
                    <div className="p-12 text-center text-gray-500 bg-gray-50/50">
                        <CreditCard className="w-12 h-12 text-gray-200 mx-auto mb-3" />
                        <p className="font-medium">No credit orders found.</p>
                    </div>
                )}
            </div>
        </div>
    );
}
