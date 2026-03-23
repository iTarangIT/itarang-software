import { db } from '@/lib/db';
import { orderDisputes, orders, users, accounts } from '@/lib/db/schema';
import { desc, eq, and, or } from 'drizzle-orm';
import Link from 'next/link';
import { requireAuth } from '@/lib/auth-utils';
import { AlertTriangle, ChevronRight, User, ShieldAlert } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function DisputesPage() {
    const user = await requireAuth();

    // Fetch disputes with order and account info
    // We show disputes assigned to the user OR created by the user OR all for CEOs
    let condition = undefined;
    if (user.role !== 'ceo' && user.role !== 'business_head') {
        condition = or(
            eq(orderDisputes.assigned_to, user.id),
            eq(orderDisputes.created_by, user.id)
        );
    }

    const allDisputes = await db.select({
        id: orderDisputes.id,
        orderId: orderDisputes.order_id,
        type: orderDisputes.dispute_type,
        status: orderDisputes.resolution_status,
        createdAt: orderDisputes.created_at,
        assignedTo: orderDisputes.assigned_to,
    })
        .from(orderDisputes)
        .where(condition)
        .orderBy(desc(orderDisputes.created_at));

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                        <ShieldAlert className="w-7 h-7 text-red-600" />
                        Order Disputes
                    </h1>
                    <p className="text-sm text-gray-500 mt-1">Track and resolve shortage, damage or delivery issues</p>
                </div>
                <Link href="/disputes/new">
                    <Button className="bg-red-600 hover:bg-red-700 text-white">Raise New Dispute</Button>
                </Link>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
                {/* Stats Summary */}
                <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">My Active Cases</p>
                    <p className="text-3xl font-black text-red-600 mt-2">
                        {allDisputes.filter(d => d.assignedTo === user.id && d.status === 'open').length}
                    </p>
                </div>
                <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">All Open Disputes</p>
                    <p className="text-3xl font-black text-orange-600 mt-2">
                        {allDisputes.filter(d => d.status === 'open').length}
                    </p>
                </div>
                <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Resolved (30 Days)</p>
                    <p className="text-3xl font-black text-green-600 mt-2">
                        {allDisputes.filter(d => d.status === 'resolved').length}
                    </p>
                </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase italic">ID</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Order / Type</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Assigned To</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Raised On</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Action</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {allDisputes.map((disp) => (
                                <tr key={disp.id} className={`${disp.assignedTo === user.id && disp.status === 'open' ? 'bg-red-50/30' : ''} hover:bg-gray-50 transition-colors`}>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                                        {disp.id}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <div className="text-sm font-bold text-gray-900">{disp.orderId}</div>
                                        <div className="text-xs text-red-600 font-medium uppercase">{disp.type.replace('_', ' ')}</div>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <div className="flex items-center gap-2 text-sm text-gray-600">
                                            {disp.assignedTo === user.id ? (
                                                <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-[10px] font-black uppercase">Me</span>
                                            ) : (
                                                <User className="w-3 h-3" />
                                            )}
                                            {disp.assignedTo === user.id ? 'Self' : 'Assigned...'}
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <span className={`px-2.5 py-1 inline-flex text-xs leading-5 font-semibold rounded-full 
                                            ${disp.status === 'resolved' ? 'bg-green-100 text-green-800' :
                                                disp.status === 'open' ? 'bg-red-100 text-red-800' :
                                                    'bg-orange-100 text-orange-800'}`}>
                                            {disp.status.toUpperCase()}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                        {new Date(disp.createdAt).toLocaleDateString()}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                        <Link href={`/disputes/${disp.id}`} className="inline-flex items-center text-red-600 hover:text-red-900 font-bold group">
                                            Resolve
                                            <ChevronRight className="w-4 h-4 ml-1 transition-transform group-hover:translate-x-1" />
                                        </Link>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {allDisputes.length === 0 && (
                    <div className="p-20 text-center text-gray-500">
                        <ShieldAlert className="w-12 h-12 mx-auto text-gray-200 mb-4" />
                        <p className="text-lg">No active disputes.</p>
                        <p className="text-sm">Great job! All customer issues are currently resolved.</p>
                    </div>
                )}
            </div>
        </div>
    );
}

// Re-using Button component specifically here if needed, or importing from UI
function Button({ children, className, ...props }: any) {
    return (
        <button className={`px-4 py-2 rounded-lg font-bold transition-all ${className}`} {...props}>
            {children}
        </button>
    );
}
