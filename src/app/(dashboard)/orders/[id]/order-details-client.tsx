'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    FileText,
    CheckCircle2,
    XCircle,
    Clock,
    IndianRupee,
    ShieldCheck,
    ArrowRight,
    Download,
    AlertTriangle
} from 'lucide-react';

interface OrderDetailsClientProps {
    order: any;
    approvals: any[];
    userRole: 'ceo' | 'business_head' | 'sales_head' | 'finance_controller' | 'inventory_manager' | 'sales_manager' | 'service_engineer';
    userId: string;
}

export default function OrderDetailsClient({ order: initialOrder, approvals, userRole, userId }: OrderDetailsClientProps) {
    const router = useRouter();
    const [order, setOrder] = useState(initialOrder);
    const [submitting, setSubmitting] = useState(false);
    const [piUrl, setPiUrl] = useState('');
    const [piAmount, setPiAmount] = useState(initialOrder.total_amount);
    const [rejectionReason, setRejectionReason] = useState('');

    const canApprove = () => {
        if (order.order_status === 'pi_approval_pending' && ['sales_head', 'ceo', 'business_head'].includes(userRole)) return 1;
        if (order.order_status === 'pi_approval_l2_pending' && ['business_head', 'ceo'].includes(userRole)) return 2;
        if (order.order_status === 'pi_approval_l3_pending' && ['finance_controller', 'ceo'].includes(userRole)) return 3;
        return 0;
    };

    const handleUploadPI = async () => {
        if (!piUrl) return;
        setSubmitting(true);
        try {
            const res = await fetch(`/api/orders/${order.id}/upload-pi`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pi_url: piUrl, pi_amount: piAmount }),
            });
            if (res.ok) router.refresh();
        } catch (err) { alert('Upload failed'); }
        finally { setSubmitting(false); }
    };

    const handleDecision = async (decision: 'approved' | 'rejected') => {
        if (decision === 'rejected' && !rejectionReason) {
            alert('Rejection reason is mandatory');
            return;
        }
        setSubmitting(true);
        try {
            const res = await fetch(`/api/orders/${order.id}/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decision, rejection_reason: rejectionReason }),
            });
            if (res.ok) router.refresh();
        } catch (err) { alert('Decision failed'); }
        finally { setSubmitting(false); }
    };

    const currentApprovalLevel = canApprove();

    return (
        <div className="max-w-6xl mx-auto space-y-8">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <div className="flex items-center gap-2 text-sm text-brand-600 font-bold mb-1">
                        <FileText className="w-4 h-4" /> PROCUREMENT ORDER
                    </div>
                    <h1 className="text-3xl font-black text-gray-900">{order.id}</h1>
                </div>
                <div className="flex items-center gap-3">
                    <span className="text-xs font-bold text-gray-400 uppercase tracking-widest bg-white px-3 py-1 rounded-full border">Status</span>
                    <span className="px-4 py-1.5 rounded-full text-sm font-bold bg-brand-600 text-white shadow-lg shadow-brand-100 uppercase">
                        {order.order_status.replace(/_/g, ' ')}
                    </span>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2 space-y-8">
                    {/* Order Details Card */}
                    <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
                        <div className="p-8 border-b border-gray-50 flex justify-between items-center">
                            <h2 className="text-xl font-bold text-gray-900">Items & Financials</h2>
                            <div className="text-right">
                                <p className="text-xs text-gray-400 font-bold uppercase tracking-wider">Total Amount</p>
                                <p className="text-2xl font-black text-brand-600">₹{parseFloat(order.total_amount).toLocaleString()}</p>
                            </div>
                        </div>
                        <div className="p-8">
                            <div className="space-y-4">
                                {(order.order_items as any[]).map((item, idx) => (
                                    <div key={idx} className="flex justify-between items-center p-4 bg-gray-50 rounded-2xl border border-gray-100 hover:border-brand-200 transition-colors">
                                        <div className="flex items-center gap-4">
                                            <div className="w-10 h-10 rounded-xl bg-white border border-gray-200 flex items-center justify-center">
                                                <ShieldCheck className="w-6 h-6 text-brand-500" />
                                            </div>
                                            <div>
                                                <p className="font-bold text-gray-900">{item.serial_number || 'N/A'}</p>
                                                <p className="text-xs text-gray-500 font-medium">Inv ID: {item.inventory_id}</p>
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-sm font-bold text-gray-900">₹{parseFloat(item.amount).toLocaleString()}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Timeline / Approvals */}
                    <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-8">
                        <h2 className="text-xl font-bold text-gray-900 mb-8">Approval History</h2>
                        <div className="space-y-8 relative">
                            <div className="absolute left-6 top-2 bottom-2 w-0.5 bg-gray-100"></div>

                            {approvals.length === 0 && (
                                <div className="pl-14 py-4 text-gray-400 italic text-sm">No approval decisions recorded yet.</div>
                            )}

                            {approvals.map((app, idx) => (
                                <div key={idx} className="relative pl-14">
                                    <div className={`absolute left-0 w-12 h-12 rounded-2xl border-4 border-white flex items-center justify-center z-10 shadow-sm ${app.status === 'approved' ? 'bg-green-500' : 'bg-red-500'
                                        }`}>
                                        {app.status === 'approved' ? <CheckCircle2 className="w-6 h-6 text-white" /> : <XCircle className="w-6 h-6 text-white" />}
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-3 mb-1">
                                            <h4 className="font-bold text-gray-900 capitalize">Level {app.level}: {app.approver_role.replace('_', ' ')}</h4>
                                            <span className="text-xs text-gray-400 font-medium">{new Date(app.decision_at).toLocaleString()}</span>
                                        </div>
                                        <p className={`text-sm font-bold mb-2 ${app.status === 'approved' ? 'text-green-600' : 'text-red-600'}`}>
                                            {app.status.toUpperCase()}
                                        </p>
                                        {(app.comments || app.rejection_reason) && (
                                            <div className="p-4 bg-gray-50 rounded-2xl text-sm text-gray-600 border border-gray-100">
                                                {app.comments || app.rejection_reason}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="space-y-8">
                    {/* Action Panel */}
                    <div className="bg-white rounded-3xl shadow-xl shadow-brand-100/20 border border-brand-100 p-8 sticky top-8">
                        <h3 className="text-lg font-bold text-gray-900 mb-6 flex items-center gap-2">
                            <Clock className="w-5 h-5 text-brand-600" />
                            Required Actions
                        </h3>

                        {/* PI Upload (Inventory Manager or CEO) */}
                        {order.order_status === 'pi_awaited' && (
                            <div className="space-y-6">
                                <div className="p-4 bg-yellow-50 rounded-2xl border border-yellow-100 flex gap-3">
                                    <AlertTriangle className="w-5 h-5 text-yellow-600 shrink-0" />
                                    <p className="text-xs text-yellow-700 font-medium">Please upload the Proforma Invoice (PI) received from the OEM to initiate the approval cycle.</p>
                                </div>
                                <div className="space-y-4">
                                    <div className="space-y-2">
                                        <Label className="text-xs font-bold text-gray-400 uppercase">PI Document URL</Label>
                                        <Input
                                            placeholder="https://..."
                                            className="h-12 rounded-xl border-gray-100 bg-gray-50"
                                            value={piUrl}
                                            onChange={(e) => setPiUrl(e.target.value)}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label className="text-xs font-bold text-gray-400 uppercase">PI Amount (₹)</Label>
                                        <Input
                                            type="number"
                                            className="h-12 rounded-xl border-gray-100 bg-gray-50"
                                            value={piAmount}
                                            onChange={(e) => setPiAmount(e.target.value)}
                                        />
                                    </div>
                                    <Button
                                        onClick={handleUploadPI}
                                        disabled={submitting || !piUrl}
                                        className="w-full h-14 rounded-2xl bg-brand-600 hover:bg-brand-700 font-bold text-lg shadow-lg shadow-brand-100"
                                    >
                                        {submitting ? 'Uploading...' : 'Submit PI for Approval'}
                                    </Button>
                                    <p className="text-[10px] text-center text-gray-400 uppercase tracking-widest font-bold">This will trigger L1 Approval notification</p>
                                </div>
                            </div>
                        )}

                        {/* Approval Actions */}
                        {currentApprovalLevel > 0 && (
                            <div className="space-y-6">
                                <div className="p-6 bg-brand-50 rounded-2xl border border-brand-100 text-center">
                                    <p className="text-sm font-bold text-brand-800 mb-1">Your Attention Required</p>
                                    <p className="text-xs text-brand-600 font-medium italic">Level {currentApprovalLevel} Review</p>
                                </div>

                                <div className="flex gap-4 p-4 bg-gray-50 rounded-2xl border border-gray-100 justify-between items-center">
                                    <div>
                                        <p className="text-[10px] font-bold text-gray-400 uppercase">PI Document</p>
                                        <a href={order.pi_url} target="_blank" className="text-sm font-bold text-brand-600 flex items-center gap-1 hover:underline">
                                            View PI <Download className="w-3 h-3" />
                                        </a>
                                    </div>
                                    <div className="text-right">
                                        <p className="text-[10px] font-bold text-gray-400 uppercase">Requested Amt</p>
                                        <p className="text-sm font-bold text-gray-900 font-mono">₹{parseFloat(order.pi_amount).toLocaleString()}</p>
                                    </div>
                                </div>

                                <div className="space-y-4 pt-4 border-t border-gray-100">
                                    <div className="space-y-2">
                                        <Label className="text-xs font-bold text-gray-400">Decision Notes (Mandatory for rejection)</Label>
                                        <textarea
                                            className="w-full rounded-2xl p-4 border-gray-100 bg-gray-50 text-sm focus:ring-brand-500"
                                            rows={3}
                                            placeholder="Add comments or rejection reason..."
                                            value={rejectionReason}
                                            onChange={(e) => setRejectionReason(e.target.value)}
                                        />
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        <Button
                                            variant="outline"
                                            onClick={() => handleDecision('rejected')}
                                            disabled={submitting}
                                            className="h-12 rounded-xl border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 font-bold"
                                        >
                                            REJECT
                                        </Button>
                                        <Button
                                            onClick={() => handleDecision('approved')}
                                            disabled={submitting}
                                            className="h-12 rounded-xl bg-green-600 hover:bg-green-700 text-white font-bold"
                                        >
                                            APPROVE
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Completed Status */}
                        {order.order_status === 'pi_approved' && (
                            <div className="space-y-6 text-center py-4">
                                <div className="w-20 h-20 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-2 border-2 border-green-100">
                                    <CheckCircle2 className="w-10 h-10 text-green-500" />
                                </div>
                                <div>
                                    <h4 className="text-xl font-bold text-gray-900">PI Fully Approved</h4>
                                    <p className="text-sm text-gray-500 mt-2 font-medium leading-relaxed">Financials have been verified by Sales, Operations, and Finance teams.</p>
                                </div>
                                <div className="pt-4 space-y-3">
                                    <Button className="w-full h-12 rounded-xl bg-gray-900 hover:bg-black font-bold flex items-center justify-center gap-2">
                                        <IndianRupee className="w-4 h-4" /> Record Payment
                                    </Button>
                                    <Button variant="outline" className="w-full h-12 rounded-xl border-gray-200 font-bold flex items-center justify-center gap-2">
                                        Update Shipping <Truck className="w-4 h-4" />
                                    </Button>
                                </div>
                            </div>
                        )}

                        {/* No actions for user */}
                        {(!canApprove() && order.order_status !== 'pi_awaited' && order.order_status !== 'pi_approved') && (
                            <div className="py-12 text-center space-y-4">
                                <div className="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center mx-auto border border-gray-100">
                                    <Clock className="w-8 h-8 text-gray-300 animate-pulse" />
                                </div>
                                <div>
                                    <p className="text-sm font-bold text-gray-400 uppercase tracking-wider">Awaiting Next Action</p>
                                    <p className="text-xs text-gray-400 mt-1 font-medium">The order is currently being processed at another level.</p>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
