import { db } from '@/lib/db';
import { approvals, deals, orders } from '@/lib/db/schema';
import { eq, and, or, desc } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { CheckCircle2, Clock, XCircle, FileText, ShoppingCart, ArrowRight } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
    const user = await requireAuth();

    // 1. Fetch pending approvals for this role
    // Sales Head handles Level 1, Business Head Level 2, Finance Level 3
    const pendingApprovals = await db.select()
        .from(approvals)
        .where(and(
            eq(approvals.status, 'pending'),
            eq(approvals.approver_role, user.role)
        ))
        .orderBy(desc(approvals.created_at));

    // 2. Fetch recent historical approvals
    const recentApprovals = await db.select()
        .from(approvals)
        .where(eq(approvals.approver_id, user.id))
        .orderBy(desc(approvals.decision_at))
        .limit(10);

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
            <div className="mb-8">
                <h1 className="text-3xl font-black text-gray-900">Decision Center</h1>
                <p className="text-sm text-gray-500 mt-1 uppercase tracking-widest font-bold">Review and process 3-level workflow approvals</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2 space-y-8">
                    {/* Pending Section */}
                    <div>
                        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                            <Clock className="w-4 h-4 text-orange-500" />
                            Awaiting Your Decision ({pendingApprovals.length})
                        </h2>
                        <div className="space-y-4">
                            {pendingApprovals.map((app) => (
                                <div key={app.id} className="bg-white rounded-2xl shadow-sm border border-orange-100 p-6 hover:shadow-md transition-shadow">
                                    <div className="flex justify-between items-start">
                                        <div className="flex items-center gap-4">
                                            <div className={`p-3 rounded-xl bg-orange-50 border border-orange-100 ${app.entity_type === 'deal' ? 'text-brand-600' : 'text-blue-600'}`}>
                                                {app.entity_type === 'deal' ? <FileText className="w-6 h-6" /> : <ShoppingCart className="w-6 h-6" />}
                                            </div>
                                            <div>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] font-black uppercase tracking-tighter bg-gray-900 text-white px-2 py-0.5 rounded">LEVEL {app.level}</span>
                                                    <h3 className="font-bold text-gray-900 uppercase tracking-tight">{app.entity_id}</h3>
                                                </div>
                                                <p className="text-sm text-gray-500 font-medium">Type: {app.entity_type.toUpperCase()}</p>
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-[10px] text-gray-400 font-bold uppercase mb-1">Assigned At</p>
                                            <p className="text-xs font-bold text-gray-900">{new Date(app.created_at).toLocaleString()}</p>
                                        </div>
                                    </div>
                                    <div className="mt-6 flex justify-end">
                                        <Link href={app.entity_type === 'deal' ? `/deals/${app.entity_id}` : `/orders/${app.entity_id}`}>
                                            <button className="flex items-center gap-2 bg-gray-900 text-white px-6 py-2.5 rounded-xl text-sm font-bold hover:bg-black transition-colors">
                                                Review & Finalize <ArrowRight className="w-4 h-4" />
                                            </button>
                                        </Link>
                                    </div>
                                </div>
                            ))}

                            {pendingApprovals.length === 0 && (
                                <div className="bg-green-50/50 border-2 border-dashed border-green-100 rounded-3xl p-16 text-center">
                                    <CheckCircle2 className="w-12 h-12 text-green-300 mx-auto mb-3" />
                                    <h3 className="text-lg font-bold text-green-800">Queue Clear</h3>
                                    <p className="text-sm text-green-600 font-medium">All tasks at Level {user.role.replace(/_/g, ' ')} have been processed.</p>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Stats Widget */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">L1 Processing</p>
                            <p className="text-2xl font-black text-gray-900">4 Hours</p>
                            <p className="text-[10px] text-green-600 font-bold mt-2 font-mono"> WITHIN SLA</p>
                        </div>
                        <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">L2 Processing</p>
                            <p className="text-2xl font-black text-gray-900">12 Hours</p>
                            <p className="text-[10px] text-orange-600 font-bold mt-2 font-mono"> NEAR BREACH</p>
                        </div>
                        <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Success Rate</p>
                            <p className="text-2xl font-black text-brand-600">94.2%</p>
                            <p className="text-[10px] text-gray-400 font-bold mt-2 font-mono"> Q1 2026</p>
                        </div>
                    </div>
                </div>

                <div className="space-y-8">
                    {/* Recent History */}
                    <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-8 h-fit">
                        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-8">Completed by You</h2>
                        <div className="space-y-6 relative border-l-2 border-gray-50 pl-6">
                            {recentApprovals.map((app) => (
                                <div key={app.id} className="relative">
                                    <div className={`absolute -left-[33px] top-0 w-4 h-4 rounded-full border-2 border-white shadow-sm ${app.status === 'approved' ? 'bg-green-500' : 'bg-red-500'}`}></div>
                                    <div>
                                        <p className="text-[10px] font-bold text-gray-400 uppercase">{app.entity_id}</p>
                                        <p className="text-sm font-bold text-gray-900 capitalize">{app.status}</p>
                                        <p className="text-[10px] text-gray-400 mt-1">{new Date(app.decision_at!).toLocaleDateString()}</p>
                                    </div>
                                </div>
                            ))}
                            {recentApprovals.length === 0 && (
                                <p className="text-xs text-gray-400 italic">No recent history</p>
                            )}
                        </div>
                    </div>

                    <div className="bg-brand-900 text-white rounded-3xl p-8 relative overflow-hidden">
                        <div className="relative z-10">
                            <h3 className="text-lg font-bold mb-2">Audit Policy</h3>
                            <p className="text-xs text-brand-50/70 leading-relaxed">
                                Every approval level is time-stamped and logged for SOP compliance.
                                L3 decisions make the record immutable.
                            </p>
                        </div>
                        <FileText className="absolute -right-4 -bottom-4 w-32 h-32 text-white/5" />
                    </div>
                </div>
            </div>
        </div>
    );
}
