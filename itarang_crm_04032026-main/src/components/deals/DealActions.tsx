'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CheckCircle, XCircle, AlertCircle } from 'lucide-react';

interface DealActionsProps {
    approvalId: string;
    dealId: string;
    role: string;
    level: number;
}

export default function DealActions({ approvalId, dealId, role, level }: DealActionsProps) {
    const router = useRouter();
    const [loading, setLoading] = useState(false);
    const [showRejectForm, setShowRejectForm] = useState(false);
    const [rejectionReason, setRejectionReason] = useState('');
    const [comments, setComments] = useState('');

    const handleApprove = async () => {
        if (loading) return;
        setLoading(true);
        try {
            const res = await fetch(`/api/approvals/${approvalId}/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ comments })
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error?.message || 'Approval failed');
            }
            alert(`L${level} Approval Successful`);
            router.refresh();
        } catch (error: any) {
            alert(error.message);
        } finally {
            setLoading(false);
        }
    };

    const handleReject = async () => {
        if (!rejectionReason || loading) return;
        setLoading(true);
        try {
            const res = await fetch(`/api/approvals/${approvalId}/reject`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rejection_reason: rejectionReason })
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error?.message || 'Rejection failed');
            }
            alert('Deal Rejected');
            router.refresh();
        } catch (error: any) {
            alert(error.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="bg-brand-50 border border-brand-100 rounded-xl p-6 mt-8">
            <div className="flex items-center gap-3 mb-4 text-brand-900 font-bold text-lg">
                <AlertCircle className="w-5 h-5 text-brand-600" />
                Action Required: Level {level} Approval ({role.replace(/_/g, ' ')})
            </div>

            <div className="space-y-4">
                <div className="space-y-2">
                    <Label>Comments (Optional)</Label>
                    <Input
                        placeholder="Add internal notes for next level..."
                        value={comments}
                        onChange={(e) => setComments(e.target.value)}
                        disabled={loading}
                    />
                </div>

                {!showRejectForm ? (
                    <div className="flex gap-3">
                        <Button
                            className="bg-green-600 hover:bg-green-700 text-white flex-1"
                            onClick={handleApprove}
                            disabled={loading}
                        >
                            <CheckCircle className="w-4 h-4 mr-2" />
                            Approve Deal
                        </Button>
                        <Button
                            variant="outline"
                            className="text-red-600 border-red-200 hover:bg-red-50 flex-1"
                            onClick={() => setShowRejectForm(true)}
                            disabled={loading}
                        >
                            <XCircle className="w-4 h-4 mr-2" />
                            Reject
                        </Button>
                    </div>
                ) : (
                    <div className="space-y-3 bg-red-50 p-4 rounded-lg border border-red-100">
                        <Label className="text-red-900 font-bold">Reason for Rejection *</Label>
                        <Input
                            placeholder="Why is this deal being rejected?"
                            value={rejectionReason}
                            onChange={(e) => setRejectionReason(e.target.value)}
                            required
                        />
                        <div className="flex gap-2">
                            <Button className="bg-red-600 hover:bg-red-700 text-white flex-1" onClick={handleReject} disabled={loading || !rejectionReason}>
                                Confirm Rejection
                            </Button>
                            <Button variant="ghost" className="flex-1" onClick={() => setShowRejectForm(false)} disabled={loading}>
                                Cancel
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
