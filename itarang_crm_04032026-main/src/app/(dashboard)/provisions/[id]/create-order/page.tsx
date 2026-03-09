'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ShoppingCart, CheckCircle2, ChevronLeft, Package, AlertCircle } from 'lucide-react';
import Link from 'next/link';

interface InventoryItem {
    id: string;
    serial_number: string | null;
    model_type: string;
    final_amount: string;
    status: string;
}

interface Provision {
    id: string;
    oem_id: string;
    oem_name: string;
}

export default function CreateOrderPage({ params }: { params: Promise<{ id: string }> }) {
    const { id: provisionId } = use(params);
    const router = useRouter();
    const [loading, setLoading] = useState(false);
    const [provision, setProvision] = useState<Provision | null>(null);
    const [items, setItems] = useState<InventoryItem[]>([]);
    const [selectedItems, setSelectedItems] = useState<string[]>([]);
    const [paymentTerm, setPaymentTerm] = useState<'advance' | 'credit'>('advance');
    const [creditDays, setCreditDays] = useState('30');
    const [expectedDate, setExpectedDate] = useState('');

    useEffect(() => {
        const fetchData = async () => {
            const res = await fetch(`/api/provisions/inventory?provision_id=${provisionId}`);
            const data = await res.json();
            if (data.success) {
                setProvision(data.data.provision);
                setItems(data.data.items.filter((i: any) => i.status === 'available'));
            }
        };
        fetchData();
    }, [provisionId]);

    const toggleItem = (itemId: string) => {
        setSelectedItems(prev =>
            prev.includes(itemId) ? prev.filter(id => id !== itemId) : [...prev, itemId]
        );
    };

    const totalAmount = items
        .filter(i => selectedItems.includes(i.id))
        .reduce((sum, i) => sum + parseFloat(i.final_amount), 0);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (selectedItems.length === 0) return;
        setLoading(true);

        try {
            const res = await fetch('/api/orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provision_id: provisionId,
                    oem_id: provision?.oem_id,
                    inventory_items: selectedItems,
                    payment_term: paymentTerm,
                    credit_period_days: paymentTerm === 'credit' ? parseInt(creditDays) : undefined,
                    expected_delivery_date: expectedDate
                }),
            });

            if (!res.ok) throw new Error('Failed to create order');
            router.push('/orders');
        } catch (err) {
            alert('Error creating order');
        } finally {
            setLoading(false);
        }
    };

    if (!provision) return <div className="p-8 text-center">Loading Provision details...</div>;

    return (
        <div className="max-w-5xl mx-auto py-8 px-4">
            <div className="mb-8 flex justify-between items-center">
                <div>
                    <Link href="/provisions" className="text-gray-500 hover:text-brand-600 flex items-center gap-1 text-sm mb-2">
                        <ChevronLeft className="w-4 h-4" /> Back to Provisions
                    </Link>
                    <h1 className="text-2xl font-bold text-gray-900">Create Order from Provision</h1>
                    <p className="text-sm text-gray-500 mt-1">Select PDI Pass assets to finalize purchase</p>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2 space-y-6">
                    {/* Item Selection */}
                    <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                        <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
                            <Package className="w-5 h-5 text-brand-600" />
                            PDI Verified Assets
                        </h3>

                        <div className="space-y-3">
                            {items.map((item) => (
                                <div
                                    key={item.id}
                                    onClick={() => toggleItem(item.id)}
                                    className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${selectedItems.includes(item.id)
                                            ? 'border-brand-500 bg-brand-50/50'
                                            : 'border-gray-50 bg-gray-50/30 hover:border-gray-200'
                                        }`}
                                >
                                    <div className="flex justify-between items-center">
                                        <div className="flex items-center gap-4">
                                            <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${selectedItems.includes(item.id) ? 'bg-brand-600 border-brand-600 text-white' : 'border-gray-300 bg-white'
                                                }`}>
                                                {selectedItems.includes(item.id) && <CheckCircle2 className="w-4 h-4" />}
                                            </div>
                                            <div>
                                                <p className="font-bold text-gray-900">{item.serial_number || 'No Serial'}</p>
                                                <p className="text-xs text-gray-500">{item.model_type}</p>
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-sm font-bold text-gray-900">₹{item.final_amount}</p>
                                            <span className="text-[10px] font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded-full border border-green-100 uppercase tracking-tighter">PDI PASS</span>
                                        </div>
                                    </div>
                                </div>
                            ))}

                            {items.length === 0 && (
                                <div className="text-center py-10 bg-gray-50 rounded-xl border-2 border-dashed border-gray-200">
                                    <AlertCircle className="w-10 h-10 text-gray-300 mx-auto mb-2" />
                                    <p className="text-gray-400 font-medium">No 'Available' assets found for this provision.</p>
                                    <p className="text-xs text-gray-400 mt-1">Complete PDI for imported items first.</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <div className="space-y-6">
                    {/* Summary & Terms */}
                    <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex flex-col h-full sticky top-8">
                        <h3 className="text-lg font-bold text-gray-900 mb-6">Order Summary</h3>

                        <div className="space-y-4 flex-grow">
                            <div>
                                <Label className="text-xs uppercase tracking-wider text-gray-400">OEM</Label>
                                <p className="font-bold text-gray-900">{provision.oem_name}</p>
                            </div>

                            <hr className="border-gray-50" />

                            <div className="space-y-2">
                                <Label>Payment Terms</Label>
                                <div className="grid grid-cols-2 gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setPaymentTerm('advance')}
                                        className={`py-2 rounded-lg text-sm font-bold border-2 transition-all ${paymentTerm === 'advance' ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-gray-100 bg-white text-gray-500'}`}
                                    >
                                        Advance
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setPaymentTerm('credit')}
                                        className={`py-2 rounded-lg text-sm font-bold border-2 transition-all ${paymentTerm === 'credit' ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-gray-100 bg-white text-gray-500'}`}
                                    >
                                        Credit
                                    </button>
                                </div>
                            </div>

                            {paymentTerm === 'credit' && (
                                <div className="space-y-1">
                                    <Label className="text-xs">Credit Period (Days)</Label>
                                    <Input
                                        type="number"
                                        value={creditDays}
                                        onChange={(e) => setCreditDays(e.target.value)}
                                        className="h-10 rounded-xl border-gray-100"
                                    />
                                </div>
                            )}

                            <div className="space-y-1">
                                <Label className="text-xs">Exp. Delivery Date</Label>
                                <Input
                                    type="date"
                                    value={expectedDate}
                                    onChange={(e) => setExpectedDate(e.target.value)}
                                    className="h-10 rounded-xl border-gray-100"
                                    required
                                />
                            </div>
                        </div>

                        <div className="mt-8 pt-6 border-t-2 border-dashed border-gray-100 space-y-4">
                            <div className="flex justify-between items-center text-sm font-medium text-gray-500">
                                <span>Items Selected</span>
                                <span>{selectedItems.length}</span>
                            </div>
                            <div className="flex justify-between items-end">
                                <span className="text-sm font-bold text-gray-900">Total Payable</span>
                                <span className="text-2xl font-black text-brand-600">₹{totalAmount.toLocaleString()}</span>
                            </div>

                            <Button
                                onClick={handleSubmit}
                                disabled={loading || selectedItems.length === 0}
                                className="w-full h-14 rounded-2xl bg-brand-600 hover:bg-brand-700 text-lg font-bold shadow-xl shadow-brand-100"
                            >
                                {loading ? 'Processing...' : 'Create Order'}
                                {!loading && <ShoppingCart className="ml-2 w-5 h-5" />}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
