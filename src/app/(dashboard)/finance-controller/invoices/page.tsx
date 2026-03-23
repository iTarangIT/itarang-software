import { db } from '@/lib/db';
import { deals, leads } from '@/lib/db/schema';
import { desc, isNotNull } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { FileText, CheckCircle2, Clock } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function FinanceInvoicesPage() {
    await requireAuth();

    const allDeals = await db.select({
        id: deals.id,
        lead_id: deals.lead_id,
        total_payable: deals.total_payable,
        invoice_number: deals.invoice_number,
        invoice_url: deals.invoice_url,
        invoice_issued_at: deals.invoice_issued_at,
        deal_status: deals.deal_status,
        is_immutable: deals.is_immutable,
        created_at: deals.created_at,
    })
        .from(deals)
        .orderBy(desc(deals.created_at));

    const invoiced = allDeals.filter(d => d.invoice_number);
    const pending = allDeals.filter(d => !d.invoice_number && d.deal_status === 'approved');

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
            <div className="mb-8">
                <h1 className="text-3xl font-black text-gray-900">Invoice Management</h1>
                <p className="text-sm text-gray-500 mt-1 uppercase tracking-widest font-bold">Track and manage deal invoices</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Total Invoices</p>
                    <p className="text-3xl font-black text-gray-900">{invoiced.length}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Pending Invoice</p>
                    <p className="text-3xl font-black text-orange-600">{pending.length}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Immutable Records</p>
                    <p className="text-3xl font-black text-green-600">{allDeals.filter(d => d.is_immutable).length}</p>
                </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Deal ID</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Invoice #</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Issued</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {allDeals.map((deal) => (
                            <tr key={deal.id} className="hover:bg-gray-50 transition-colors">
                                <td className="px-6 py-4 whitespace-nowrap">
                                    <Link href={`/deals/${deal.id}`} className="text-sm font-bold text-blue-600 hover:underline">{deal.id}</Link>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{deal.invoice_number || '—'}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-900">
                                    {Number(deal.total_payable).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                                    {deal.invoice_issued_at ? new Date(deal.invoice_issued_at).toLocaleDateString() : '—'}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                    {deal.invoice_number ? (
                                        <span className="flex items-center gap-1 text-xs font-bold text-green-700"><CheckCircle2 className="w-3.5 h-3.5" /> Invoiced</span>
                                    ) : deal.deal_status === 'approved' ? (
                                        <span className="flex items-center gap-1 text-xs font-bold text-orange-600"><Clock className="w-3.5 h-3.5" /> Pending</span>
                                    ) : (
                                        <span className="text-xs font-bold text-gray-400">{deal.deal_status.replace(/_/g, ' ')}</span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {allDeals.length === 0 && (
                    <div className="p-12 text-center text-gray-500 bg-gray-50/50">
                        <FileText className="w-12 h-12 text-gray-200 mx-auto mb-3" />
                        <p className="font-medium">No deals found.</p>
                    </div>
                )}
            </div>
        </div>
    );
}
