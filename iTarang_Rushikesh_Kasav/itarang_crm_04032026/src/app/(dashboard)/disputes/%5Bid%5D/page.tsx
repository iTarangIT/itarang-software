'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ArrowLeft, ShieldAlert, CheckCircle2, History, MessageSquare, Camera } from 'lucide-react';

export default function DisputeDetailPage() {
    const router = useRouter();
    const params = useParams();
    const disputeId = params.id as string;

    const [dispute, setDispute] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [resolving, setResolving] = useState(false);
    const [resolutionDetails, setResolutionDetails] = useState('');
    const [actionTaken, setActionTaken] = useState('');

    useEffect(() => {
        fetch(`/api/disputes/${disputeId}`)
            .then(res => res.json())
            .then(data => {
                setDispute(data.data);
                setLoading(false);
            })
            .catch(console.error);
    }, [disputeId]);

    // Note: We need a detail GET API if we want specific info, 
    // but the list API often provides enough if we fetch single.
    // For now, I'll implement a Mock GET in case I missed creating the route.
    // Actually, let's assume we need to fetch it.

    const handleResolve = async (e: React.FormEvent) => {
        e.preventDefault();
        setResolving(true);
        try {
            const res = await fetch(`/api/disputes/${disputeId}/resolve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ resolution_details: resolutionDetails, action_taken: actionTaken })
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error?.message || 'Resolution failed');
            }

            alert('Dispute Resolved');
            router.refresh();
            router.push('/disputes');
        } catch (error: any) {
            alert(error.message);
        } finally {
            setResolving(false);
        }
    };

    if (loading) return <div className="p-12 text-center">Loading Dispute...</div>;
    if (!dispute) return <div className="p-12 text-center text-red-500">Dispute not found</div>;

    const isResolved = dispute.resolution_status === 'resolved' || dispute.resolution_status === 'closed';

    return (
        <div className="max-w-4xl mx-auto py-8 px-4">
            <Button variant="ghost" onClick={() => router.back()} className="mb-6 pl-0 hover:bg-transparent">
                <ArrowLeft className="w-4 h-4 mr-2" /> Back to List
            </Button>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2 space-y-6">
                    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8">
                        <div className="flex justify-between items-start mb-6">
                            <div>
                                <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                                    <ShieldAlert className="w-6 h-6 text-red-600" />
                                    {dispute.id}
                                </h1>
                                <p className="text-gray-500 mt-1 uppercase text-xs font-black tracking-widest">{dispute.dispute_type.replace('_', ' ')}</p>
                            </div>
                            <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase
                                ${isResolved ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                {dispute.resolution_status}
                            </span>
                        </div>

                        <div className="space-y-6">
                            <div>
                                <Label className="text-gray-400">Issue Description</Label>
                                <p className="mt-2 text-gray-800 bg-gray-50 p-4 rounded-lg border italic">
                                    "{dispute.description}"
                                </p>
                            </div>

                            <div>
                                <Label className="text-gray-400">Evidence / Photos</Label>
                                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-2">
                                    {dispute.photos_urls && dispute.photos_urls.length > 0 ? (
                                        dispute.photos_urls.map((url: string, i: number) => (
                                            <div key={i} className="aspect-square bg-gray-100 rounded-lg overflow-hidden border">
                                                <img src={url} alt="Evidence" className="w-full h-full object-cover" />
                                            </div>
                                        ))
                                    ) : (
                                        <div className="col-span-full border-2 border-dashed rounded-lg p-8 text-center text-gray-400 text-sm">
                                            No photos provided for this dispute.
                                        </div>
                                    )}
                                </div>
                            </div>

                            {isResolved && (
                                <div className="space-y-4 pt-6 border-t border-gray-100 bg-green-50/30 p-4 rounded-xl">
                                    <h3 className="text-green-800 font-bold flex items-center gap-2">
                                        <CheckCircle2 className="w-5 h-5" />
                                        Resolution Documented
                                    </h3>
                                    <div>
                                        <Label className="text-green-700">Resolution Details</Label>
                                        <p className="text-gray-800 mt-1">{dispute.resolution_details}</p>
                                    </div>
                                    <div>
                                        <Label className="text-green-700">Action Taken</Label>
                                        <p className="text-gray-800 mt-1">{dispute.action_taken}</p>
                                    </div>
                                </div>
                            )}

                            {!isResolved && (
                                <form onSubmit={handleResolve} className="space-y-4 pt-6 border-t border-gray-100">
                                    <h3 className="text-gray-800 font-bold">Action Resolution</h3>
                                    <div className="space-y-2">
                                        <Label>Resolution Summary *</Label>
                                        <textarea
                                            className="w-full min-h-[100px] p-3 rounded-md border border-gray-300 outline-none focus:ring-2 focus:ring-brand-500"
                                            placeholder="Explain how the issue was resolved..."
                                            value={resolutionDetails}
                                            onChange={(e) => setResolutionDetails(e.target.value)}
                                            required
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>Action Taken *</Label>
                                        <Input
                                            placeholder="e.g. Replenished stock, Processed refund"
                                            value={actionTaken}
                                            onChange={(e) => setActionTaken(e.target.value)}
                                            required
                                        />
                                    </div>
                                    <Button type="submit" className="w-full bg-green-600 hover:bg-green-700 text-white font-bold" disabled={resolving || !resolutionDetails || !actionTaken}>
                                        {resolving ? 'Saving...' : 'Mark as Resolved'}
                                    </Button>
                                </form>
                            )}
                        </div>
                    </div>
                </div>

                <div className="space-y-6">
                    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                        <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-6">Case Context</h3>
                        <div className="space-y-4">
                            <div className="flex items-start gap-3">
                                <History className="w-5 h-5 text-gray-400" />
                                <div>
                                    <p className="text-xs font-bold text-gray-500 uppercase">Order Reference</p>
                                    <p className="text-sm font-bold text-brand-600">{dispute.order_id}</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3">
                                <MessageSquare className="w-5 h-5 text-gray-400" />
                                <div>
                                    <p className="text-xs font-bold text-gray-500 uppercase">Raised By</p>
                                    <p className="text-sm text-gray-900">User ID: {dispute.created_by}</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="bg-red-50 border border-red-100 p-6 rounded-xl">
                        <h4 className="text-red-900 font-bold text-sm mb-2 flex items-center gap-2">
                            <ShieldAlert className="w-4 h-4" />
                            Security Protocol
                        </h4>
                        <p className="text-xs text-red-800 leading-relaxed">
                            Order fulfillment for <strong>{dispute.order_id}</strong> is locked while this dispute is open. Resolution requires verification of inventory or damage evidence.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
