'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Package, Plus, Trash2, Calendar, Building2, CheckCircle } from 'lucide-react';

interface OEM {
    id: string;
    business_entity_name: string;
}

interface Product {
    id: string;
    model_type: string;
    asset_type: string;
}

export default function NewProvisionPage() {
    const router = useRouter();
    const [loading, setLoading] = useState(false);
    const [oems, setOems] = useState<OEM[]>([]);
    const [products, setProducts] = useState<Product[]>([]);
    const [selectedOem, setSelectedOem] = useState('');
    const [expectedDate, setExpectedDate] = useState('');
    const [remarks, setRemarks] = useState('');
    const [items, setItems] = useState<{ product_id: string, model_type: string, quantity: number }[]>([]);

    useEffect(() => {
        const fetchData = async () => {
            const [oemRes, prodRes] = await Promise.all([
                fetch('/api/oems'),
                fetch('/api/product-catalog')
            ]);
            const oemData = await oemRes.json();
            const prodData = await prodRes.json();
            setOems(oemData.data || []);
            setProducts(prodData.data || []);
        };
        fetchData();
    }, []);

    const addItem = () => {
        setItems([...items, { product_id: '', model_type: '', quantity: 1 }]);
    };

    const removeItem = (index: number) => {
        setItems(items.filter((_, i) => i !== index));
    };

    const handleItemChange = (index: number, field: string, value: any) => {
        const newItems = [...items];
        if (field === 'product_id') {
            const prod = products.find(p => p.id === value);
            newItems[index].product_id = value;
            newItems[index].model_type = prod?.model_type || '';
        } else {
            newItems[index].quantity = parseInt(value) || 0;
        }
        setItems(newItems);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);

        try {
            const res = await fetch('/api/provisions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    oem_id: selectedOem,
                    expected_delivery_date: expectedDate,
                    products: items,
                    remarks
                }),
            });

            if (!res.ok) throw new Error('Failed to create provision');

            router.push('/provisions');
        } catch (err) {
            console.error(err);
            alert('Error creating provision');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="max-w-4xl mx-auto py-8 px-4">
            <div className="mb-8">
                <h1 className="text-2xl font-bold text-gray-900">Create New Provision</h1>
                <p className="text-sm text-gray-500 mt-1">Request new stock from an OEM</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-8">
                {/* Header Info */}
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-2">
                            <Label>Select OEM</Label>
                            <div className="relative">
                                <Building2 className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                                <select
                                    className="w-full h-10 pl-10 rounded-xl border-gray-200 focus:ring-brand-500 focus:border-brand-500"
                                    value={selectedOem}
                                    onChange={(e) => setSelectedOem(e.target.value)}
                                    required
                                >
                                    <option value="">Select an OEM</option>
                                    {oems.map((oem) => (
                                        <option key={oem.id} value={oem.id}>{oem.business_entity_name}</option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <Label>Expected Delivery Date</Label>
                            <div className="relative">
                                <Calendar className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                                <Input
                                    type="date"
                                    className="pl-10 h-10 rounded-xl border-gray-200"
                                    value={expectedDate}
                                    onChange={(e) => setExpectedDate(e.target.value)}
                                    required
                                />
                            </div>
                        </div>
                    </div>

                    <div className="mt-6 space-y-2">
                        <Label>Remarks (Optional)</Label>
                        <textarea
                            className="w-full rounded-xl border-gray-200 focus:ring-brand-500 focus:border-brand-500 p-3"
                            rows={3}
                            placeholder="Add any specific instructions or context..."
                            value={remarks}
                            onChange={(e) => setRemarks(e.target.value)}
                        />
                    </div>
                </div>

                {/* Products List */}
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                    <div className="flex justify-between items-center mb-6">
                        <h3 className="font-bold text-gray-900 flex items-center gap-2">
                            <Package className="w-5 h-5 text-brand-600" />
                            Products to Order
                        </h3>
                        <Button type="button" variant="outline" size="sm" onClick={addItem}>
                            <Plus className="w-4 h-4 mr-1" /> Add Product
                        </Button>
                    </div>

                    <div className="space-y-4">
                        {items.map((item, index) => (
                            <div key={index} className="flex gap-4 items-end p-4 bg-gray-50 rounded-xl animate-in fade-in slide-in-from-left-2">
                                <div className="flex-1 space-y-2">
                                    <Label className="text-xs">Product Type</Label>
                                    <select
                                        className="w-full h-10 rounded-lg border-gray-200 bg-white"
                                        value={item.product_id}
                                        onChange={(e) => handleItemChange(index, 'product_id', e.target.value)}
                                        required
                                    >
                                        <option value="">Select Product Variant</option>
                                        {products.map((p) => (
                                            <option key={p.id} value={p.id}>{p.model_type} ({p.asset_type})</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="w-32 space-y-2">
                                    <Label className="text-xs">Quantity</Label>
                                    <Input
                                        type="number"
                                        min="1"
                                        className="h-10 rounded-lg border-gray-200"
                                        value={item.quantity}
                                        onChange={(e) => handleItemChange(index, 'quantity', e.target.value)}
                                        required
                                    />
                                </div>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="text-red-400 hover:text-red-600 hover:bg-red-50"
                                    onClick={() => removeItem(index)}
                                >
                                    <Trash2 className="w-4 h-4" />
                                </Button>
                            </div>
                        ))}

                        {items.length === 0 && (
                            <div className="text-center py-8 border-2 border-dashed border-gray-100 rounded-xl">
                                <p className="text-sm text-gray-400">No products added yet.</p>
                                <Button type="button" variant="link" size="sm" onClick={addItem} className="text-brand-600 font-bold">
                                    Tap to add product
                                </Button>
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex justify-end pt-4">
                    <Button
                        type="submit"
                        disabled={loading || items.length === 0}
                        className="bg-brand-600 hover:bg-brand-700 min-w-[200px] h-12 rounded-xl text-lg font-bold shadow-lg"
                    >
                        {loading ? 'Creating...' : 'Submit Provision Request'}
                        {!loading && <CheckCircle className="ml-2 w-5 h-5" />}
                    </Button>
                </div>
            </form>
        </div>
    );
}
