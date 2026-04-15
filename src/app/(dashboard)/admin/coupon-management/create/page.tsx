'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ArrowLeft, Ticket, CheckCircle2 } from 'lucide-react';

type DealerOption = {
    id: string;
    business_name: string | null;
};

export default function CreateCouponBatchPage() {
    const router = useRouter();
    const [dealers, setDealers] = useState<DealerOption[]>([]);
    const [loadingDealers, setLoadingDealers] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [success, setSuccess] = useState<{ batchId: string; count: number } | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Form state
    const [batchName, setBatchName] = useState('');
    const [dealerId, setDealerId] = useState('');
    const [couponValue, setCouponValue] = useState(0);
    const [quantity, setQuantity] = useState(100);
    const [prefix, setPrefix] = useState('');
    const [expiryDate, setExpiryDate] = useState('');
    const [discountType, setDiscountType] = useState<'flat' | 'percentage'>('flat');

    useEffect(() => {
        const fetchDealers = async () => {
            try {
                const res = await fetch('/api/admin/dealers?status=active&limit=500');
                const data = await res.json();
                if (data.success) {
                    setDealers(data.data || []);
                }
            } catch { /* silent */ }
            finally { setLoadingDealers(false); }
        };
        fetchDealers();
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);

        if (!batchName.trim()) { setError('Batch name is required'); return; }
        if (!dealerId) { setError('Please select a dealer'); return; }
        if (quantity < 1 || quantity > 10000) { setError('Quantity must be between 1 and 10,000'); return; }
        if (expiryDate && new Date(expiryDate) <= new Date()) { setError('Expiry date must be in the future'); return; }

        setSubmitting(true);
        try {
            const res = await fetch('/api/admin/coupons/create-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    batch_name: batchName.trim(),
                    dealer_id: dealerId,
                    coupon_value: couponValue,
                    count: quantity,
                    prefix: prefix.trim() || undefined,
                    discount_type: discountType,
                    expiry_date: expiryDate || undefined,
                }),
            });
            const data = await res.json();
            if (data.success) {
                setSuccess({ batchId: data.data.batchId, count: data.data.totalCoupons });
            } else {
                setError(data.error?.message || 'Failed to create batch');
            }
        } catch {
            setError('Failed to create batch');
        } finally {
            setSubmitting(false);
        }
    };

    if (success) {
        return (
            <div className="min-h-screen bg-[#F8F9FA] p-6 flex items-center justify-center">
                <div className="bg-white border border-gray-200 rounded-2xl p-8 max-w-md w-full text-center space-y-4">
                    <CheckCircle2 className="w-16 h-16 text-emerald-500 mx-auto" />
                    <h2 className="text-xl font-bold text-gray-900">Batch Created Successfully!</h2>
                    <p className="text-sm text-gray-600">
                        <span className="font-mono font-bold">{success.batchId}</span> with{' '}
                        <span className="font-bold">{success.count}</span> coupons generated.
                    </p>
                    <div className="flex items-center gap-3 justify-center pt-4">
                        <button
                            onClick={() => router.push(`/admin/coupon-management/${success.batchId}`)}
                            className="px-5 py-2.5 bg-teal-600 text-white rounded-xl text-sm font-bold hover:bg-teal-700 transition"
                        >
                            View Batch
                        </button>
                        <button
                            onClick={() => router.push('/admin/coupon-management')}
                            className="px-5 py-2.5 border border-gray-200 rounded-xl text-sm font-medium hover:bg-gray-50 transition"
                        >
                            Back to List
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#F8F9FA] p-6">
            <div className="max-w-2xl mx-auto space-y-6">
                {/* Header */}
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => router.back()}
                        className="p-2 hover:bg-gray-100 rounded-lg transition"
                    >
                        <ArrowLeft className="w-5 h-5 text-gray-600" />
                    </button>
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                            <Ticket className="w-6 h-6 text-teal-600" />
                            Create Coupon Batch
                        </h1>
                        <p className="text-sm text-gray-500 mt-0.5">Generate verification coupons for a dealer</p>
                    </div>
                </div>

                {/* Form */}
                <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-2xl p-6 space-y-5">
                    {/* Batch Name */}
                    <div>
                        <label className="block text-sm font-semibold text-gray-700 mb-1.5">Batch Name *</label>
                        <input
                            type="text"
                            value={batchName}
                            onChange={e => setBatchName(e.target.value)}
                            placeholder="e.g., ABC Motors - January 2026"
                            maxLength={200}
                            className="w-full h-11 px-4 bg-white border-2 border-gray-200 rounded-xl outline-none text-sm focus:border-teal-500 transition"
                        />
                    </div>

                    {/* Dealer */}
                    <div>
                        <label className="block text-sm font-semibold text-gray-700 mb-1.5">Select Dealer *</label>
                        {loadingDealers ? (
                            <div className="flex items-center gap-2 text-sm text-gray-400 py-2">
                                <Loader2 className="w-4 h-4 animate-spin" /> Loading dealers...
                            </div>
                        ) : (
                            <select
                                value={dealerId}
                                onChange={e => setDealerId(e.target.value)}
                                className="w-full h-11 px-4 bg-white border-2 border-gray-200 rounded-xl outline-none text-sm focus:border-teal-500 transition"
                            >
                                <option value="">-- Select a dealer --</option>
                                {dealers.map(d => (
                                    <option key={d.id} value={d.id}>
                                        {d.business_name || d.id}
                                    </option>
                                ))}
                            </select>
                        )}
                    </div>

                    {/* Coupon Value & Discount Type */}
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-semibold text-gray-700 mb-1.5">Coupon Value (₹) *</label>
                            <input
                                type="number"
                                value={couponValue}
                                onChange={e => setCouponValue(Number(e.target.value))}
                                min={0}
                                max={10000}
                                className="w-full h-11 px-4 bg-white border-2 border-gray-200 rounded-xl outline-none text-sm focus:border-teal-500 transition"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-semibold text-gray-700 mb-1.5">Discount Type</label>
                            <select
                                value={discountType}
                                onChange={e => setDiscountType(e.target.value as 'flat' | 'percentage')}
                                className="w-full h-11 px-4 bg-white border-2 border-gray-200 rounded-xl outline-none text-sm focus:border-teal-500 transition"
                            >
                                <option value="flat">Flat (₹)</option>
                                <option value="percentage">Percentage (%)</option>
                            </select>
                        </div>
                    </div>

                    {/* Quantity & Prefix */}
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-semibold text-gray-700 mb-1.5">Quantity *</label>
                            <input
                                type="number"
                                value={quantity}
                                onChange={e => setQuantity(Number(e.target.value))}
                                min={1}
                                max={10000}
                                className="w-full h-11 px-4 bg-white border-2 border-gray-200 rounded-xl outline-none text-sm focus:border-teal-500 transition"
                            />
                            <p className="text-xs text-gray-400 mt-1">Min: 1, Max: 10,000 per batch</p>
                        </div>
                        <div>
                            <label className="block text-sm font-semibold text-gray-700 mb-1.5">Coupon Prefix (Optional)</label>
                            <input
                                type="text"
                                value={prefix}
                                onChange={e => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
                                placeholder="e.g., ABCDEL"
                                maxLength={10}
                                className="w-full h-11 px-4 bg-white border-2 border-gray-200 rounded-xl outline-none text-sm font-mono focus:border-teal-500 transition"
                            />
                            <p className="text-xs text-gray-400 mt-1">Auto-generated if blank</p>
                        </div>
                    </div>

                    {/* Expiry Date */}
                    <div>
                        <label className="block text-sm font-semibold text-gray-700 mb-1.5">Expiry Date (Optional)</label>
                        <input
                            type="date"
                            value={expiryDate}
                            onChange={e => setExpiryDate(e.target.value)}
                            min={new Date().toISOString().slice(0, 10)}
                            className="w-full h-11 px-4 bg-white border-2 border-gray-200 rounded-xl outline-none text-sm focus:border-teal-500 transition"
                        />
                        <p className="text-xs text-gray-400 mt-1">Leave blank for no expiry</p>
                    </div>

                    {/* Error */}
                    {error && (
                        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 font-medium">
                            {error}
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-3 pt-2">
                        <button
                            type="button"
                            onClick={() => router.back()}
                            className="px-5 py-2.5 border border-gray-200 rounded-xl text-sm font-medium hover:bg-gray-50 transition"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={submitting}
                            className="px-6 py-2.5 bg-teal-600 text-white rounded-xl text-sm font-bold hover:bg-teal-700 transition disabled:opacity-50 flex items-center gap-2"
                        >
                            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                            Generate Batch
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
