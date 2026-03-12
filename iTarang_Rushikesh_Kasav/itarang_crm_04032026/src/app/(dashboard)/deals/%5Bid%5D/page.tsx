import { db } from '@/lib/db';
import { deals, leads, approvals, users } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, Clock, XCircle, FileText } from 'lucide-react';
import DealActions from '@/components/deals/DealActions';

export const dynamic = 'force-dynamic';

export default async function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id: dealId } = await params;
    const user = await requireAuth();

    // Fetch Deal with Lead
    const [deal] = await db.select().from(deals).where(eq(deals.id, dealId)).limit(1);
    if (!deal) return <div className="p-12 text-center text-gray-500">Deal not found</div>;

    const [lead] = await db.select().from(leads).where(eq(leads.id, deal.lead_id)).limit(1);

    // Fetch Approvals
    const approvalHistory = await db.select()
        .from(approvals)
        .where(and(eq(approvals.entity_type, 'deal'), eq(approvals.entity_id, dealId)))
        .orderBy(approvals.level);

    // Current pending approval for this user?
    const currentPendingApproval = approvalHistory.find(a => a.status === 'pending');
    const isUserApprover = currentPendingApproval?.approver_role === user.role;

    return (
        <div className="max-w-5xl mx-auto py-8 px-4">
            <Link href="/deals">
                <Button variant="ghost" className="mb-4 pl-0 hover:bg-transparent hover:text-brand-600 group">
                    <ArrowLeft className="w-4 h-4 mr-2 transition-transform group-hover:-translate-x-1" /> Back to Deals
                </Button>
            </Link>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Left Column: Deal Details */}
                <div className="lg:col-span-2 space-y-6">
                    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8">
                        <div className="flex justify-between items-start mb-6 border-b pb-6">
                            <div>
                                <h1 className="text-2xl font-bold text-gray-900">
                                    Quote: {deal.id}
                                    {deal.is_immutable && <span className="ml-3 text-xs bg-gray-900 text-white px-2 py-0.5 rounded uppercase tracking-widest">Immutable</span>}
                                </h1>
                                <p className="text-gray-500 mt-1">For {lead.business_name || lead.owner_name}</p>
                            </div>
                            <div className="text-right">
                                <span className={`px-3 py-1 rounded-full text-sm font-bold uppercase
                                    ${deal.deal_status === 'approved' ? 'bg-green-100 text-green-800' :
                                        deal.deal_status === 'rejected' ? 'bg-red-100 text-red-800' :
                                            'bg-orange-100 text-orange-800'}`}>
                                    {deal.deal_status?.replace(/_/g, ' ')}
                                </span>
                            </div>
                        </div>

                        {/* Order Items */}
                        <div className="space-y-4">
                            <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest">Ordered Products</h3>
                            <div className="divide-y border rounded-lg overflow-hidden">
                                {(deal.products as any[]).map((p, i) => (
                                    <div key={i} className="flex justify-between p-4 text-sm hover:bg-gray-50">
                                        <div>
                                            <p className="font-bold text-gray-900">{p.product_name}</p>
                                            <p className="text-gray-500">Qty: {p.quantity} × ₹{Number(p.unit_price).toLocaleString()}</p>
                                        </div>
                                        <div className="text-right">
                                            <p className="font-bold text-gray-900">₹{Number(p.subtotal).toLocaleString()}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Financial Summary */}
                        <div className="mt-8 space-y-2 bg-gray-50 p-6 rounded-xl border border-dashed border-gray-300">
                            <div className="flex justify-between text-sm text-gray-600">
                                <span>Line Total</span>
                                <span>₹{Number(deal.line_total).toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between text-sm text-gray-600">
                                <span>GST (18%)</span>
                                <span>₹{Number(deal.gst_amount).toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between text-sm text-gray-600">
                                <span>Transportation</span>
                                <span>₹{Number(deal.transportation_cost).toLocaleString()} (+ {deal.transportation_gst_percent}% GST)</span>
                            </div>
                            <div className="flex justify-between pt-4 border-t border-gray-300 text-xl font-black text-gray-900">
                                <span>Total Payable</span>
                                <span>₹{Number(deal.total_payable).toLocaleString()}</span>
                            </div>
                        </div>

                        {/* Actions for User */}
                        {isUserApprover && currentPendingApproval && (
                            <DealActions
                                approvalId={currentPendingApproval.id}
                                dealId={dealId}
                                role={user.role}
                                level={currentPendingApproval.level}
                            />
                        )}
                    </div>
                </div>

                {/* Right Column: Approval Timeline */}
                <div className="space-y-6">
                    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                        <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-6">Approval Timeline</h3>
                        <div className="relative space-y-8 before:absolute before:left-3 before:top-2 before:bottom-2 before:w-0.5 before:bg-gray-100">
                            {approvalHistory.map((step) => (
                                <div key={step.id} className="relative pl-10">
                                    <div className={`absolute left-0 top-1 w-6 h-6 rounded-full flex items-center justify-center z-10
                                        ${step.status === 'approved' ? 'bg-green-100 text-green-600 border-2 border-green-200' :
                                            step.status === 'rejected' ? 'bg-red-100 text-red-600 border-2 border-red-200' :
                                                'bg-white text-gray-300 border-2 border-gray-200'}`}>
                                        {step.status === 'approved' ? <CheckCircle2 className="w-4 h-4" /> :
                                            step.status === 'rejected' ? <XCircle className="w-4 h-4" /> :
                                                <Clock className="w-4 h-4" />}
                                    </div>
                                    <div>
                                        <p className="text-xs font-bold uppercase tracking-tight text-gray-400">Level {step.level}</p>
                                        <p className="font-bold text-gray-900 capitalize">{step.approver_role.replace(/_/g, ' ')}</p>
                                        <p className={`text-sm font-semibold mt-1 ${step.status === 'approved' ? 'text-green-600' : step.status === 'rejected' ? 'text-red-600' : 'text-gray-500'}`}>
                                            {step.status.toUpperCase()}
                                        </p>
                                        {step.decision_at && <p className="text-[10px] text-gray-400 mt-1">{new Date(step.decision_at).toLocaleString()}</p>}
                                        {step.comments && <p className="text-xs italic bg-gray-50 p-2 border rounded mt-2 text-gray-600">"{step.comments}"</p>}
                                        {step.rejection_reason && <p className="text-xs italic bg-red-50 p-2 border border-red-100 rounded mt-2 text-red-600">"{step.rejection_reason}"</p>}
                                    </div>
                                </div>
                            ))}
                            {approvalHistory.length < 3 && !approvalHistory.find(a => a.status === 'rejected') && (
                                <div className="pl-10 text-gray-300 italic text-sm">Waiting for previous levels...</div>
                            )}
                        </div>
                    </div>

                    <div className="bg-blue-50 border border-blue-100 p-6 rounded-xl text-sm">
                        <div className="flex items-start gap-3">
                            <FileText className="w-5 h-5 text-blue-600 mt-0.5" />
                            <div>
                                <p className="font-bold text-blue-900">SOP Note</p>
                                <p className="text-blue-800 mt-1">Once Finance (L3) approves, the deal status becomes immutable and an invoice is automatically issued.</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
