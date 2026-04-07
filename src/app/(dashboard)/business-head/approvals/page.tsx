import { db } from '@/lib/db';
import { approvals } from '@/lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { CheckCircle2, Clock, FileText, ArrowRight } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function BusinessHeadApprovalsPage() {
    const user = await requireAuth();

    const pendingApprovals = await db.select()
        .from(approvals)
        .where(and(
            eq(approvals.status, 'pending'),
            eq(approvals.approver_role, 'business_head'),
            eq(approvals.level, 2)
        ))
        .orderBy(desc(approvals.created_at));

    const recentApprovals = await db.select()
        .from(approvals)
        .where(and(
            eq(approvals.approver_role, 'business_head'),
            eq(approvals.level, 2)
        ))
        .orderBy(desc(approvals.decision_at))
        .limit(20);

    const completedCount = recentApprovals.filter(a => a.status !== 'pending').length;

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
            <div className="mb-8">
                <h1 className="text-3xl font-black text-gray-900">Level 2 Approvals</h1>
                <p className="text-sm text-gray-500 mt-1 uppercase tracking-widest font-bold">Business Head - Strategic Deal Approvals</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Pending</p>
                    <p className="text-3xl font-black text-orange-600">{pendingApprovals.length}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Completed (Recent)</p>
                    <p className="text-3xl font-black text-green-600">{completedCount}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">SLA Target</p>
                    <p className="text-3xl font-black text-gray-900">12 Hours</p>
                </div>
            </div>

            <div className="space-y-4">
                <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest flex items-center gap-2">
                    <Clock className="w-4 h-4 text-orange-500" />
                    Awaiting Your Decision ({pendingApprovals.length})
                </h2>

                {pendingApprovals.map((app) => (
                    <div key={app.id} className="bg-white rounded-2xl shadow-sm border border-orange-100 p-6 hover:shadow-md transition-shadow">
                        <div className="flex justify-between items-start">
                            <div className="flex items-center gap-4">
                                <div className="p-3 rounded-xl bg-blue-50 border border-blue-100 text-blue-600">
                                    <FileText className="w-6 h-6" />
                                </div>
                                <div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] font-black uppercase tracking-tighter bg-blue-900 text-white px-2 py-0.5 rounded">LEVEL 2</span>
                                        <h3 className="font-bold text-gray-900 uppercase tracking-tight">{app.entity_id}</h3>
                                    </div>
                                    <p className="text-sm text-gray-500 font-medium">Type: {app.entity_type.toUpperCase()}</p>
                                </div>
                            </div>
                            <div className="text-right">
                                <p className="text-[10px] text-gray-400 font-bold uppercase mb-1">Created</p>
                                <p className="text-xs font-bold text-gray-900">{new Date(app.created_at).toLocaleString()}</p>
                            </div>
                        </div>
                        <div className="mt-4 flex justify-end">
                            <Link href={app.entity_type === 'deal' ? `/deals/${app.entity_id}` : `/orders/${app.entity_id}`}>
                                <button className="flex items-center gap-2 bg-gray-900 text-white px-6 py-2.5 rounded-xl text-sm font-bold hover:bg-black transition-colors">
                                    Review & Decide <ArrowRight className="w-4 h-4" />
                                </button>
                            </Link>
                        </div>
                    </div>
                ))}

                {pendingApprovals.length === 0 && (
                    <div className="bg-green-50/50 border-2 border-dashed border-green-100 rounded-3xl p-16 text-center">
                        <CheckCircle2 className="w-12 h-12 text-green-300 mx-auto mb-3" />
                        <h3 className="text-lg font-bold text-green-800">All Clear</h3>
                        <p className="text-sm text-green-600 font-medium">No pending Level 2 approvals.</p>
                    </div>
                )}
            </div>
        </div>
    );
}
