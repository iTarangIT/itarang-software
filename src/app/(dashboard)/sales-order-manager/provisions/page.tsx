import { db } from '@/lib/db';
import { provisions } from '@/lib/db/schema';
import { desc } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { Package, Plus, CheckCircle2, Clock, Truck } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const STATUS_COLORS: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-700',
    acknowledged: 'bg-blue-100 text-blue-700',
    in_production: 'bg-purple-100 text-purple-700',
    ready_for_pdi: 'bg-indigo-100 text-indigo-700',
    completed: 'bg-green-100 text-green-700',
    cancelled: 'bg-red-100 text-red-700',
};

export default async function SOMProvisionsPage() {
    await requireAuth();

    const allProvisions = await db.select()
        .from(provisions)
        .orderBy(desc(provisions.created_at));

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-3xl font-black text-gray-900">Provisions</h1>
                    <p className="text-sm text-gray-500 mt-1 uppercase tracking-widest font-bold">Manage procurement provisions</p>
                </div>
                <Link href="/provisions/new">
                    <button className="flex items-center gap-2 bg-gray-900 text-white px-6 py-2.5 rounded-xl text-sm font-bold hover:bg-black transition-colors">
                        <Plus className="w-4 h-4" /> New Provision
                    </button>
                </Link>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Provision ID</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">OEM</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Expected Delivery</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {allProvisions.map((prov) => (
                            <tr key={prov.id} className="hover:bg-gray-50 transition-colors">
                                <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-900">{prov.id}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{prov.oem_name}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                                    {new Date(prov.expected_delivery_date).toLocaleDateString()}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                    <span className={`px-3 py-1 rounded-full text-xs font-bold ${STATUS_COLORS[prov.status] || 'bg-gray-100 text-gray-600'}`}>
                                        {prov.status.replace(/_/g, ' ').toUpperCase()}
                                    </span>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-right">
                                    <Link href={`/provisions/${prov.id}/create-order`} className="text-sm font-bold text-blue-600 hover:underline">
                                        Manage
                                    </Link>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {allProvisions.length === 0 && (
                    <div className="p-12 text-center text-gray-500 bg-gray-50/50">
                        <Package className="w-12 h-12 text-gray-200 mx-auto mb-3" />
                        <p className="font-medium">No provisions found.</p>
                        <p className="text-sm">Create a provision to start the procurement process.</p>
                    </div>
                )}
            </div>
        </div>
    );
}
