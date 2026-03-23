import { db } from '@/lib/db';
import { orders } from '@/lib/db/schema';
import { desc } from 'drizzle-orm';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ShoppingCart, FileText, IndianRupee, Truck, CheckCircle2, AlertCircle } from 'lucide-react';
import { requireAuth } from '@/lib/auth-utils';

export const dynamic = 'force-dynamic';

const STATUS_MAP: Record<string, { label: string, color: string, icon: any }> = {
    pi_awaited: { label: 'PI Awaited', color: 'bg-yellow-100 text-yellow-800 border-yellow-200', icon: FileText },
    pi_approval_pending: { label: 'PI Approval Pending', color: 'bg-orange-100 text-orange-800 border-orange-200', icon: AlertCircle },
    pi_approved: { label: 'PI Approved', color: 'bg-blue-100 text-blue-800 border-blue-200', icon: CheckCircle2 },
    payment_made: { label: 'Payment Made', color: 'bg-green-100 text-green-800 border-green-200', icon: IndianRupee },
    in_transit: { label: 'In Transit', color: 'bg-purple-100 text-purple-800 border-purple-200', icon: Truck },
    delivered: { label: 'Delivered', color: 'bg-gray-100 text-gray-800 border-gray-200', icon: CheckCircle2 },
    cancelled: { label: 'Cancelled', color: 'bg-red-100 text-red-800 border-red-200', icon: AlertCircle },
};

export default async function OrdersPage() {
    await requireAuth();

    const allOrders = await db.select()
        .from(orders)
        .orderBy(desc(orders.created_at));

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Procurement Orders</h1>
                    <p className="text-sm text-gray-500 mt-1">Manage purchase orders and OEM confirmations</p>
                </div>
            </div>

            <div className="grid gap-4">
                <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Order ID</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">OEM / Amount</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Payment Status</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Order Status</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {allOrders.map((order) => {
                                const status = STATUS_MAP[order.order_status] || STATUS_MAP.pi_awaited;
                                const StatusIcon = status.icon;

                                return (
                                    <tr key={order.id} className="hover:bg-gray-50 transition-colors">
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <div className="text-sm font-bold text-gray-900">{order.id}</div>
                                            <div className="text-xs text-brand-600 font-medium">{order.provision_id}</div>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <div className="text-sm text-gray-900 font-medium">OEM ID: {order.oem_id}</div>
                                            <div className="text-sm font-bold text-gray-900">₹{order.total_amount}</div>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                            <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${order.payment_status === 'paid' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
                                                }`}>
                                                {order.payment_status.toUpperCase()}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <span className={`px-3 py-1 rounded-full text-xs font-bold border flex items-center gap-1.5 w-fit ${status.color}`}>
                                                <StatusIcon className="w-3.5 h-3.5" />
                                                {status.label.toUpperCase()}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                            <Link href={`/orders/${order.id}`}>
                                                <Button variant="ghost" size="sm" className="text-brand-600 hover:text-brand-900">
                                                    Manage
                                                </Button>
                                            </Link>
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
                            <p className="text-sm">Orders are created after assets pass PDI verification.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
