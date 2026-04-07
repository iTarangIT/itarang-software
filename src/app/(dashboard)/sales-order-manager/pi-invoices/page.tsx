import { db } from '@/lib/db';
import { orders } from '@/lib/db/schema';
import { desc } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { FileText, CheckCircle2, Clock, ExternalLink } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function SOMPiInvoicesPage() {
    await requireAuth();

    const allOrders = await db.select()
        .from(orders)
        .orderBy(desc(orders.created_at));

    const withPI = allOrders.filter(o => o.pi_url);
    const withInvoice = allOrders.filter(o => o.invoice_url);
    const awaitingPI = allOrders.filter(o => !o.pi_url && o.order_status === 'pi_awaited');

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
            <div className="mb-8">
                <h1 className="text-3xl font-black text-gray-900">PI & Invoice Tracking</h1>
                <p className="text-sm text-gray-500 mt-1 uppercase tracking-widest font-bold">Proforma Invoices and final invoices</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">PI Received</p>
                    <p className="text-3xl font-black text-blue-600">{withPI.length}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Invoiced</p>
                    <p className="text-3xl font-black text-green-600">{withInvoice.length}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Awaiting PI</p>
                    <p className="text-3xl font-black text-orange-600">{awaitingPI.length}</p>
                </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Order ID</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">PI Amount</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">PI Document</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Invoice</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Order Status</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {allOrders.map((order) => (
                            <tr key={order.id} className="hover:bg-gray-50 transition-colors">
                                <td className="px-6 py-4 whitespace-nowrap">
                                    <Link href={`/orders/${order.id}`} className="text-sm font-bold text-blue-600 hover:underline">{order.id}</Link>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                                    {order.pi_amount ? Number(order.pi_amount).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }) : '—'}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm">
                                    {order.pi_url ? (
                                        <span className="flex items-center gap-1 text-green-600 font-bold"><CheckCircle2 className="w-3.5 h-3.5" /> Uploaded</span>
                                    ) : (
                                        <span className="flex items-center gap-1 text-gray-400 font-bold"><Clock className="w-3.5 h-3.5" /> Awaiting</span>
                                    )}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm">
                                    {order.invoice_url ? (
                                        <span className="flex items-center gap-1 text-green-600 font-bold"><CheckCircle2 className="w-3.5 h-3.5" /> Uploaded</span>
                                    ) : (
                                        <span className="text-gray-400 font-bold">—</span>
                                    )}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                    <span className="px-3 py-1 rounded-full text-xs font-bold bg-gray-100 text-gray-700">
                                        {order.order_status.replace(/_/g, ' ').toUpperCase()}
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {allOrders.length === 0 && (
                    <div className="p-12 text-center text-gray-500 bg-gray-50/50">
                        <FileText className="w-12 h-12 text-gray-200 mx-auto mb-3" />
                        <p className="font-medium">No orders found.</p>
                    </div>
                )}
            </div>
        </div>
    );
}
