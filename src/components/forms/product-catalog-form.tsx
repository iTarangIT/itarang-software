'use client';

import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function ProductCatalogForm() {
    const queryClient = useQueryClient();
    const [formData, setFormData] = useState({
        name: '',
        slug: '',
        category_id: '',
        hsn_code: '',
        sku: '',
        asset_type: '',
        voltage_v: '',
        capacity_ah: '',
        is_serialized: true,
        warranty_months: 36,
        sort_order: 0,
    });

    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

    const { data: categoriesData } = useQuery({
        queryKey: ['product-categories'],
        queryFn: () => fetch('/api/inventory/categories').then(r => r.json()),
    });
    const categories: { id: string; name: string; slug: string }[] = categoriesData?.data || [];

    // Auto-generate slug from name
    useEffect(() => {
        if (formData.name) {
            setFormData(prev => ({
                ...prev,
                slug: formData.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
            }));
        }
    }, [formData.name]);

    const createMutation = useMutation({
        mutationFn: async (data: any) => {
            const payload = {
                ...data,
                voltage_v: data.voltage_v ? Number(data.voltage_v) : undefined,
                capacity_ah: data.capacity_ah ? Number(data.capacity_ah) : undefined,
                warranty_months: Number(data.warranty_months),
                sort_order: Number(data.sort_order),
            };
            const res = await fetch('/api/product-catalog', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const error = await res.json();
                throw new Error(error.error?.message || 'Failed to create product');
            }
            return res.json();
        },
        onSuccess: () => {
            setMessage({ type: 'success', text: 'Product created successfully!' });
            queryClient.invalidateQueries({ queryKey: ['product-catalog'] });
            setFormData({
                name: '',
                slug: '',
                category_id: '',
                hsn_code: '',
                sku: '',
                asset_type: '',
                voltage_v: '',
                capacity_ah: '',
                is_serialized: true,
                warranty_months: 36,
                sort_order: 0,
            });
        },
        onError: (error: any) => {
            setMessage({ type: 'error', text: error.message });
        }
    });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setMessage(null);
        createMutation.mutate(formData);
    };

    return (
        <div className="max-w-2xl mx-auto bg-white p-8 rounded-2xl border border-gray-100 shadow-sm">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">Create New Product</h2>

            <form onSubmit={handleSubmit} className="space-y-6">

                {message && (
                    <div className={`p-4 rounded-xl flex items-center gap-3 ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                        {message.type === 'success' ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                        <p className="text-sm font-medium">{message.text}</p>
                    </div>
                )}

                <div className="grid grid-cols-2 gap-6">
                    <div>
                        <label className="block text-sm font-semibold text-gray-700 mb-2">Product Name</label>
                        <Input
                            placeholder="e.g. 3W Battery 51V 105AH"
                            value={formData.name}
                            onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                            required
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-semibold text-gray-700 mb-2">SKU</label>
                        <Input
                            placeholder="e.g. 3W-51V-105AH"
                            value={formData.sku}
                            onChange={(e) => setFormData(prev => ({ ...prev, sku: e.target.value }))}
                        />
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-6">
                    <div>
                        <label className="block text-sm font-semibold text-gray-700 mb-2">Category</label>
                        <select
                            className="flex h-10 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                            value={formData.category_id}
                            onChange={(e) => setFormData(prev => ({ ...prev, category_id: e.target.value }))}
                            required
                        >
                            <option value="">Select Category</option>
                            {categories.map(cat => (
                                <option key={cat.id} value={cat.id}>{cat.name}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-semibold text-gray-700 mb-2">Asset Type</label>
                        <select
                            className="flex h-10 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                            value={formData.asset_type}
                            onChange={(e) => setFormData(prev => ({ ...prev, asset_type: e.target.value }))}
                        >
                            <option value="">Select Type</option>
                            <option value="Battery">Battery</option>
                            <option value="Charger">Charger</option>
                            <option value="SOC">SOC (Monitor)</option>
                            <option value="Harness">Harness</option>
                            <option value="Inverter">Inverter Unit</option>
                        </select>
                    </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                    <div>
                        <label className="block text-sm font-semibold text-gray-700 mb-2">HSN Code</label>
                        <Input
                            placeholder="85076000"
                            maxLength={8}
                            value={formData.hsn_code}
                            onChange={(e) => setFormData(prev => ({ ...prev, hsn_code: e.target.value }))}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-semibold text-gray-700 mb-2">Voltage (V)</label>
                        <Input
                            type="number"
                            placeholder="e.g. 51"
                            value={formData.voltage_v}
                            onChange={(e) => setFormData(prev => ({ ...prev, voltage_v: e.target.value }))}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-semibold text-gray-700 mb-2">Capacity (AH)</label>
                        <Input
                            type="number"
                            placeholder="e.g. 105"
                            value={formData.capacity_ah}
                            onChange={(e) => setFormData(prev => ({ ...prev, capacity_ah: e.target.value }))}
                        />
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-6">
                    <div>
                        <label className="block text-sm font-semibold text-gray-700 mb-2">Warranty (Months)</label>
                        <Input
                            type="number"
                            value={formData.warranty_months}
                            onChange={(e) => setFormData(prev => ({ ...prev, warranty_months: parseInt(e.target.value) }))}
                            required
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-semibold text-gray-700 mb-2">Sort Order</label>
                        <Input
                            type="number"
                            value={formData.sort_order}
                            onChange={(e) => setFormData(prev => ({ ...prev, sort_order: parseInt(e.target.value) }))}
                        />
                    </div>
                </div>

                <div className="flex items-center gap-2 pt-2">
                    <input
                        type="checkbox"
                        id="serialized"
                        checked={formData.is_serialized}
                        onChange={(e) => setFormData(prev => ({ ...prev, is_serialized: e.target.checked }))}
                        className="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                    />
                    <label htmlFor="serialized" className="text-sm font-medium text-gray-700">
                        Maintain Individual Serial Numbers (Recommended)
                    </label>
                </div>

                <Button
                    type="submit"
                    className="w-full h-12 bg-brand-600 hover:bg-brand-700 text-white font-bold text-lg shadow-lg shadow-brand-500/20"
                    disabled={createMutation.isPending}
                >
                    {createMutation.isPending ? (
                        <>
                            <Loader2 className="w-5 h-5 animate-spin mr-2" />
                            Processing...
                        </>
                    ) : 'Register Product in Catalog'}
                </Button>
            </form>
        </div>
    );
}
