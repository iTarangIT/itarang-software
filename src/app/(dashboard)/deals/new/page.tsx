'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Plus, Trash2, Calculator, Loader2 } from 'lucide-react';

interface Product {
    id: string;
    name: string;
    sku?: string;
}

function NewDealForm() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const leadId = searchParams.get('lead_id');

    const [catalog, setCatalog] = useState<Product[]>([]);
    const [selectedProducts, setSelectedProducts] = useState<any[]>([]);
    const [transportation, setTransportation] = useState(0);
    const [transportationGst, setTransportationGst] = useState(18);
    const [paymentTerm, setPaymentTerm] = useState<'cash' | 'credit'>('cash');
    const [creditPeriod, setCreditPeriod] = useState(1);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        // Fetch product catalog for selection
        fetch('/api/product-catalog')
            .then(res => res.json())
            .then(data => setCatalog(data.data || []))
            .catch(console.error);
    }, []);

    const addProduct = () => {
        setSelectedProducts([...selectedProducts, { product_id: '', quantity: 1, unit_price: 0 }]);
    };

    const removeProduct = (index: number) => {
        setSelectedProducts(selectedProducts.filter((_, i) => i !== index));
    };

    const updateProduct = (index: number, field: string, value: any) => {
        const updated = [...selectedProducts];
        updated[index] = { ...updated[index], [field]: value };

        // Auto-fill price if product changes
        if (field === 'product_id') {
            const p = catalog.find(item => item.id === value);
            if (p) updated[index].unit_price = p.base_price;
        }

        setSelectedProducts(updated);
    };

    // Calculations
    const lineTotal = selectedProducts.reduce((sum, p) => sum + (p.unit_price * p.quantity), 0);
    const gstAmount = lineTotal * 0.18; // Default 18% GST for products
    const transportTotal = transportation * (1 + transportationGst / 100);
    const totalPayable = lineTotal + gstAmount + transportTotal;

    const onSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!leadId) {
            alert('Lead ID is missing');
            return;
        }
        if (selectedProducts.length === 0) {
            alert('Add at least one product');
            return;
        }

        setLoading(true);
        try {
            const res = await fetch('/api/deals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    lead_id: leadId,
                    products: selectedProducts.map(p => ({
                        product_id: p.product_id,
                        product_name: catalog.find(c => c.id === p.product_id)?.name || 'Product',
                        quantity: Number(p.quantity),
                        unit_price: Number(p.unit_price),
                        subtotal: p.unit_price * p.quantity
                    })),
                    line_total: lineTotal,
                    gst_amount: gstAmount,
                    transportation_cost: transportation,
                    transportation_gst_percent: transportationGst,
                    payment_term: paymentTerm,
                    credit_period_months: paymentTerm === 'credit' ? creditPeriod : undefined,
                })
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error?.message || 'Failed to create deal');
            }

            const data = await res.json();
            router.push(`/deals/${data.data.id}`);
            router.refresh();
        } catch (error: any) {
            alert(error.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="max-w-4xl mx-auto py-8 px-4">
            <h1 className="text-2xl font-bold mb-6 text-gray-900">Create New Quote / Deal</h1>

            <form onSubmit={onSubmit} className="space-y-8 bg-white p-8 rounded-xl border border-gray-100 shadow-sm">

                {/* Product Selection */}
                <div className="space-y-4">
                    <div className="flex justify-between items-center">
                        <h3 className="text-lg font-semibold text-gray-800">Products & Battery Selection</h3>
                        <Button type="button" variant="outline" size="sm" onClick={addProduct}>
                            <Plus className="w-4 h-4 mr-2" /> Add Product
                        </Button>
                    </div>

                    {selectedProducts.map((p, index) => (
                        <div key={index} className="grid grid-cols-12 gap-4 items-end bg-gray-50 p-4 rounded-lg border border-gray-200">
                            <div className="col-span-12 sm:col-span-5 space-y-2">
                                <Label>Product Model</Label>
                                <Select
                                    value={p.product_id}
                                    onChange={(e) => updateProduct(index, 'product_id', e.target.value)}
                                    required
                                >
                                    <option value="">Select Product</option>
                                    {catalog.map(item => (
                                        <option key={item.id} value={item.id}>{item.name}</option>
                                    ))}
                                </Select>
                            </div>
                            <div className="col-span-4 sm:col-span-2 space-y-2">
                                <Label>Quantity</Label>
                                <Input
                                    type="number"
                                    min="1"
                                    value={p.quantity}
                                    onChange={(e) => updateProduct(index, 'quantity', Number(e.target.value))}
                                    required
                                />
                            </div>
                            <div className="col-span-5 sm:col-span-3 space-y-2">
                                <Label>Unit Price (₹)</Label>
                                <Input
                                    type="number"
                                    value={p.unit_price}
                                    onChange={(e) => updateProduct(index, 'unit_price', Number(e.target.value))}
                                    required
                                />
                            </div>
                            <div className="col-span-3 sm:col-span-2 flex justify-end pb-2">
                                <Button type="button" variant="ghost" size="sm" onClick={() => removeProduct(index)} className="text-red-500 hover:text-red-700">
                                    <Trash2 className="w-4 h-4" />
                                </Button>
                            </div>
                        </div>
                    ))}
                    {selectedProducts.length === 0 && <p className="text-gray-500 text-sm italic">No products added yet.</p>}
                </div>

                {/* Logistics & Terms */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 pt-6 border-t">
                    <div className="space-y-6">
                        <h3 className="text-lg font-semibold text-gray-800">Logistics & Transportation</h3>
                        <div className="space-y-2">
                            <Label>Transportation Cost (Base ₹)</Label>
                            <Input type="number" value={transportation} onChange={(e) => setTransportation(Number(e.target.value))} />
                        </div>
                        <div className="space-y-2">
                            <Label>Transportation GST %</Label>
                            <Select value={transportationGst} onChange={(e) => setTransportationGst(Number(e.target.value))}>
                                <option value="5">5%</option>
                                <option value="12">12%</option>
                                <option value="18">18%</option>
                            </Select>
                        </div>
                    </div>

                    <div className="space-y-6">
                        <h3 className="text-lg font-semibold text-gray-800">Payment Terms</h3>
                        <div className="space-y-2">
                            <Label>Payment Mode</Label>
                            <Select value={paymentTerm} onChange={(e) => setPaymentTerm(e.target.value as any)}>
                                <option value="cash">Full Advance / Cash</option>
                                <option value="credit">Credit Basis</option>
                            </Select>
                        </div>
                        {paymentTerm === 'credit' && (
                            <div className="space-y-2">
                                <Label>Credit Period (Months)</Label>
                                <Input type="number" min="1" max="12" value={creditPeriod} onChange={(e) => setCreditPeriod(Number(e.target.value))} />
                            </div>
                        )}
                    </div>
                </div>

                {/* Totals Summary */}
                <div className="bg-brand-50 p-6 rounded-xl border border-brand-100 mt-8">
                    <div className="flex items-center gap-2 text-brand-700 mb-4 font-semibold">
                        <Calculator className="w-5 h-5" />
                        Summary of Payable
                    </div>
                    <div className="space-y-3 text-sm">
                        <div className="flex justify-between">
                            <span className="text-gray-600">Line Total (Net)</span>
                            <span className="font-medium">₹{lineTotal.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-gray-600">GST on Products (18%)</span>
                            <span className="font-medium">₹{gstAmount.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-gray-600">Transportation (with GST)</span>
                            <span className="font-medium">₹{transportTotal.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between pt-3 border-t border-brand-200 text-lg font-bold text-brand-900">
                            <span>Total Payable</span>
                            <span>₹{totalPayable.toLocaleString()}</span>
                        </div>
                    </div>
                </div>

                <div className="flex justify-end gap-3 pt-6">
                    <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
                    <Button type="submit" disabled={loading} className="px-8 font-bold">
                        {loading ? 'Processing...' : 'Generate Quote & Send for Approval'}
                    </Button>
                </div>
            </form>
        </div>
    );
}

export default function NewDealPage() {
    return (
        <Suspense fallback={
            <div className="flex items-center justify-center min-h-[400px]">
                <Loader2 className="w-8 h-8 text-brand-600 animate-spin" />
            </div>
        }>
            <NewDealForm />
        </Suspense>
    );
}
