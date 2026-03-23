import { db } from '@/lib/db';
import { deals, leads, accounts } from '@/lib/db/schema';
import { eq, desc, sql } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { CreditCard, TrendingUp, AlertTriangle, IndianRupee } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function BusinessHeadCreditsPage() {
    await requireAuth();

    const creditDeals = await db.select({
        id: deals.id,
        lead_id: deals.lead_id,
        total_payable: deals.total_payable,
        credit_period_months: deals.credit_period_months,
        deal_status: deals.deal_status,
        payment_term: deals.payment_term,
        created_at: deals.created_at,
        lead_name: leads.full_name,
    })
        .from(deals)
        .innerJoin(leads, eq(deals.lead_id, leads.id))
        .where(eq(deals.payment_term, 'credit'))
        .orderBy(desc(deals.created_at));

    const totalExposure = creditDeals.reduce((sum, d) => sum + Number(d.total_payable || 0), 0);
    const activeCount = creditDeals.filter(d => !['rejected', 'expired'].includes(d.deal_status)).length;

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
            <div className="mb-8">
                <h1 className="text-3xl font-black text-gray-900">Credit Exposure</h1>
                <p className="text-sm text-gray-500 mt-1 uppercase tracking-widest font-bold">Monitor credit deals and aging</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Total Exposure</p>
                    <p className="text-3xl font-black text-gray-900">{totalExposure.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Active Credit Deals</p>
                    <p className="text-3xl font-black text-blue-600">{activeCount}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Total Credit Deals</p>
                    <p className="text-3xl font-black text-gray-600">{creditDeals.length}</p>
                </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Deal ID</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Customer</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Credit Period</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {creditDeals.map((deal) => (
                            <tr key={deal.id} className="hover:bg-gray-50 transition-colors">
                                <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-900">{deal.id}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{deal.lead_name || 'N/A'}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-900">
                                    {Number(deal.total_payable).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">{deal.credit_period_months || '—'} months</td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                    <span className={`px-3 py-1 rounded-full text-xs font-bold ${deal.deal_status === 'approved' ? 'bg-green-100 text-green-700' : deal.deal_status === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}`}>
                                        {deal.deal_status.replace(/_/g, ' ').toUpperCase()}
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {creditDeals.length === 0 && (
                    <div className="p-12 text-center text-gray-500 bg-gray-50/50">
                        <CreditCard className="w-12 h-12 text-gray-200 mx-auto mb-3" />
                        <p className="font-medium">No credit deals found.</p>
                        <p className="text-sm">Credit deals will appear here once created.</p>
                    </div>
                )}
            </div>
        </div>
    );
}
