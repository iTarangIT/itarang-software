import { db } from '@/lib/db';
import { couponBatches, accounts, couponCodes, users } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { Plus, Tag, Calendar, Users, Percent, CheckCircle, XCircle } from 'lucide-react';
import Link from 'next/link';
import { format } from 'date-fns';

export default async function CouponsManagementPage() {
    // Fetch coupon batches with dealer information
    const batchesData = await db
        .select({
            id: couponBatches.id,
            batch_name: couponBatches.batch_name,
            coupon_value: couponBatches.coupon_value,
            total_quantity: couponBatches.total_quantity,
            prefix: couponBatches.prefix,
            expiry_date: couponBatches.expiry_date,
            status: couponBatches.status,
            dealerName: accounts.business_name,
            created_at: couponBatches.created_at,
        })
        .from(couponBatches)
        .leftJoin(accounts, eq(couponBatches.dealer_id, accounts.id))
        .orderBy(desc(couponBatches.created_at));

    return (
        <div className="max-w-7xl mx-auto space-y-6">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-slate-900">Coupons Management</h1>
                    <p className="text-sm text-slate-500 mt-1">
                        Manage discount and facilitation fee coupon batches tailored by dealers.
                    </p>
                </div>
                <button className="inline-flex items-center gap-2 bg-brand-600 hover:bg-brand-700 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-all shadow-sm hover:shadow">
                    <Plus className="w-4 h-4" />
                    Create New Batch
                </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-gradient-to-br from-indigo-500 to-indigo-600 p-6 rounded-2xl text-white shadow-indigo-200/50 shadow-lg">
                    <div className="flex items-center justify-between mb-4">
                        <Tag className="w-6 h-6 text-indigo-100" />
                        <span className="bg-indigo-400/30 text-xs font-semibold px-2 py-1 rounded-full">Total Batches</span>
                    </div>
                    <p className="text-3xl font-bold tracking-tight">{batchesData.length || 0}</p>
                    <p className="text-indigo-100 text-sm mt-1">Active distribution programs</p>
                </div>
                <div className="bg-gradient-to-br from-teal-500 to-teal-600 p-6 rounded-2xl text-white shadow-teal-200/50 shadow-lg">
                    <div className="flex items-center justify-between mb-4">
                        <Percent className="w-6 h-6 text-teal-100" />
                        <span className="bg-teal-400/30 text-xs font-semibold px-2 py-1 rounded-full">Coupons Generated</span>
                    </div>
                    <p className="text-3xl font-bold tracking-tight">
                        {batchesData.reduce((acc, batch) => acc + (batch.total_quantity || 0), 0)}
                    </p>
                    <p className="text-teal-100 text-sm mt-1">Available across all dealers</p>
                </div>
                <div className="bg-gradient-to-br from-rose-500 to-amber-500 p-6 rounded-2xl text-white shadow-rose-200/50 shadow-lg">
                    <div className="flex items-center justify-between mb-4">
                        <CheckCircle className="w-6 h-6 text-white/80" />
                        <span className="bg-white/20 text-xs font-semibold px-2 py-1 rounded-full">Used Coupons</span>
                    </div>
                    <p className="text-3xl font-bold tracking-tight">0</p>
                    <p className="text-rose-100 text-sm mt-1">Redeemed by leads</p>
                </div>
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
                <div className="p-6 border-b border-slate-100">
                    <h2 className="text-lg font-semibold text-slate-800">Recent Coupon Batches</h2>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left">
                        <thead className="bg-slate-50 text-slate-500 uppercase font-medium text-xs">
                            <tr>
                                <th className="px-6 py-4 rounded-tl-xl whitespace-nowrap">Batch Name</th>
                                <th className="px-6 py-4">Dealer</th>
                                <th className="px-6 py-4">Details</th>
                                <th className="px-6 py-4">Status</th>
                                <th className="px-6 py-4 text-right rounded-tr-xl">Created On</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {batchesData.length === 0 ? (
                                <tr>
                                    <td colSpan={5} className="px-6 py-12 text-center text-slate-500">
                                        <div className="flex justify-center bg-slate-50 w-16 h-16 rounded-full items-center mx-auto mb-3">
                                            <Tag className="w-8 h-8 text-slate-400" />
                                        </div>
                                        <p className="text-base font-semibold text-slate-700">No coupon batches found</p>
                                        <p className="text-sm mt-1">No coupons have been generated for dealers yet.</p>
                                    </td>
                                </tr>
                            ) : (
                                batchesData.map((batch) => (
                                    <tr key={batch.id} className="hover:bg-slate-50/50 transition-colors">
                                        <td className="px-6 py-4">
                                            <div className="font-semibold text-slate-900">{batch.batch_name}</div>
                                            <div className="text-xs text-slate-500 mt-1 uppercase tracking-wide flex items-center gap-1">
                                                Prefix: <span className="font-mono bg-slate-100 px-1 py-0.5 rounded text-brand-600">{batch.prefix}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex gap-2 items-center">
                                                <div className="w-7 h-7 bg-brand-50 text-brand-700 rounded-full flex items-center justify-center font-bold text-xs uppercase">
                                                    {(batch.dealerName || 'D')[0]}
                                                </div>
                                                <span className="font-medium text-slate-700">{batch.dealerName || 'Unknown Dealer'}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex flex-col gap-1">
                                                <div className="text-slate-900 font-medium">₹{batch.coupon_value} off</div>
                                                <div className="text-xs text-slate-500">{batch.total_quantity} total codes</div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            {batch.status === 'active' ? (
                                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200/60">
                                                    <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full" />
                                                    Active
                                                </span>
                                            ) : batch.status === 'expired' ? (
                                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-50 text-red-700 border border-red-200/60">
                                                    <span className="w-1.5 h-1.5 bg-red-500 rounded-full" />
                                                    Expired
                                                </span>
                                            ) : (
                                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">
                                                    {batch.status}
                                                </span>
                                            )}
                                            {batch.expiry_date && (
                                                <div className="text-xs text-slate-400 mt-1.5 flex items-center gap-1">
                                                    <Calendar className="w-3 h-3" />
                                                    Exp: {format(new Date(batch.expiry_date), 'MMM dd, yyyy')}
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-6 py-4 text-right text-slate-500 text-sm">
                                            {batch.created_at ? format(new Date(batch.created_at), 'MMM dd, yyyy') : '-'}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
