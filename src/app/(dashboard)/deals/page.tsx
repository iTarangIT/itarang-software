import { db } from '@/lib/db';
import { deals, leads } from '@/lib/db/schema';
import { desc, eq } from 'drizzle-orm';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { requireAuth } from '@/lib/auth-utils';
import { FileText, ChevronRight } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function DealsPage() {
    const user = await requireAuth();

    // Fetch deals with lead info
    const allDeals = await db.select({
        id: deals.id,
        status: deals.deal_status,
        total: deals.total_payable,
        createdAt: deals.created_at,
        businessName: leads.business_name,
        leadOwner: leads.owner_name,
    })
        .from(deals)
        .innerJoin(leads, eq(deals.lead_id, leads.id))
        .orderBy(desc(deals.created_at));

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Deals & Quotes</h1>
                    <p className="text-sm text-gray-500 mt-1">Monitor multi-level approvals and conversion status</p>
                </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Deal ID</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Business / Lead</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Total Payable</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Action</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {allDeals.map((deal) => (
                                <tr key={deal.id} className="hover:bg-gray-50 transition-colors">
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                                        <div className="flex items-center gap-2">
                                            <FileText className="w-4 h-4 text-gray-400" />
                                            {deal.id}
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <div className="text-sm font-medium text-gray-900">{deal.businessName || 'N/A'}</div>
                                        <div className="text-xs text-gray-500">{deal.leadOwner}</div>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-900">
                                        ₹{Number(deal.total).toLocaleString()}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <span className={`px-2.5 py-1 inline-flex text-xs leading-5 font-semibold rounded-full 
                                            ${deal.status === 'approved' ? 'bg-green-100 text-green-800' :
                                                deal.status === 'rejected' ? 'bg-red-100 text-red-800' :
                                                    deal.status === 'expired' ? 'bg-gray-100 text-gray-800' :
                                                        'bg-orange-100 text-orange-800 animate-pulse'}`}>
                                            {deal.status?.replace(/_/g, ' ').toUpperCase()}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                        {new Date(deal.createdAt).toLocaleDateString()}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                        <Link href={`/deals/${deal.id}`} className="inline-flex items-center text-brand-600 hover:text-brand-900 font-bold group">
                                            Manage
                                            <ChevronRight className="w-4 h-4 ml-1 transition-transform group-hover:translate-x-1" />
                                        </Link>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {allDeals.length === 0 && (
                    <div className="p-16 text-center text-gray-500">
                        <FileText className="w-12 h-12 mx-auto text-gray-300 mb-4" />
                        <p className="text-lg">No quotes or deals found.</p>
                        <p className="text-sm">Initiate a deal from a Hot lead detail page.</p>
                    </div>
                )}
            </div>
        </div>
    );
}
