'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { AlertTriangle, Info, Camera, Loader2 } from 'lucide-react';

function NewDisputeForm() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const orderIdParam = searchParams.get('order_id');

    const [orders, setOrders] = useState<any[]>([]);
    const [selectedOrder, setSelectedOrder] = useState(orderIdParam || '');
    const [disputeType, setDisputeType] = useState<'damage' | 'shortage' | 'delivery_failure'>('shortage');
    const [description, setDescription] = useState('');
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        // Fetch recent orders for selection
        fetch('/api/orders')
            .then(res => res.json())
            .then(data => setOrders(data.data || []))
            .catch(console.error);
    }, []);

    const onSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedOrder) return alert('Please select an order');

        setLoading(true);
        try {
            const res = await fetch('/api/disputes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    order_id: selectedOrder,
                    dispute_type: disputeType,
                    description,
                    photos_urls: [] // Storage integration placeholder
                })
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error?.message || 'Failed to raise dispute');
            }

            alert('Dispute raised successfully');
            router.push('/disputes');
            router.refresh();
        } catch (error: any) {
            alert(error.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="max-w-3xl mx-auto py-8 px-4">
            <h1 className="text-2xl font-bold mb-6 text-gray-900 flex items-center gap-2">
                <AlertTriangle className="w-6 h-6 text-red-500" />
                Raise Order Dispute
            </h1>

            <form onSubmit={onSubmit} className="space-y-6 bg-white p-8 rounded-xl border border-gray-200 shadow-sm">
                <div className="space-y-2">
                    <Label>Select Order</Label>
                    <Select value={selectedOrder} onChange={(e) => setSelectedOrder(e.target.value)} required>
                        <option value="">-- Choose Order --</option>
                        {orders.map(o => (
                            <option key={o.id} value={o.id}>{o.id} ({o.account?.business_name || 'N/A'})</option>
                        ))}
                    </Select>
                </div>

                <div className="space-y-2">
                    <Label>Dispute Type</Label>
                    <Select value={disputeType} onChange={(e) => setDisputeType(e.target.value as any)} required>
                        <option value="shortage">Quantity Shortage (Auto-assigned to Inventory Manager)</option>
                        <option value="damage">Physical Damage (Auto-assigned to Sales Head)</option>
                        <option value="delivery_failure">Delivery Failure (Auto-assigned to Sales Head)</option>
                    </Select>
                </div>

                <div className="bg-blue-50 p-4 rounded-lg flex gap-3 text-sm text-blue-800 border border-blue-100">
                    <Info className="w-5 h-5 flex-shrink-0" />
                    <div>
                        <p className="font-bold">Auto-Assignment Logic</p>
                        <p className="mt-1">
                            Disputes for <strong>Shortage</strong> are assigned to the <strong>Inventory Manager</strong>.
                            All others are handled by the <strong>Sales Head</strong>.
                        </p>
                    </div>
                </div>

                <div className="space-y-2">
                    <Label>Description & Findings</Label>
                    <textarea
                        className="w-full min-h-[150px] p-3 rounded-md border border-gray-300 focus:ring-2 focus:ring-brand-500 outline-none"
                        placeholder="Provide details about the issue..."
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        required
                    />
                </div>

                <div className="space-y-2">
                    <Label>Photos / Evidence</Label>
                    <div className="border-2 border-dashed border-gray-200 rounded-lg p-8 text-center bg-gray-50">
                        <Camera className="w-8 h-8 mx-auto text-gray-400 mb-2" />
                        <p className="text-sm text-gray-500">Photo upload integration pending (Supabase Storage)</p>
                        <Button type="button" variant="outline" size="sm" className="mt-3" disabled>
                            Browse Photos
                        </Button>
                    </div>
                </div>

                <div className="flex justify-end gap-3 pt-6 border-t">
                    <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
                    <Button type="submit" className="bg-red-600 hover:bg-red-700 text-white font-bold px-8" disabled={loading}>
                        {loading ? 'Submitting...' : 'Raise Dispute'}
                    </Button>
                </div>
            </form>
        </div>
    );
}

export default function NewDisputePage() {
    return (
        <Suspense fallback={
            <div className="flex items-center justify-center min-h-[400px]">
                <Loader2 className="w-8 h-8 text-brand-600 animate-spin" />
            </div>
        }>
            <NewDisputeForm />
        </Suspense>
    );
}
