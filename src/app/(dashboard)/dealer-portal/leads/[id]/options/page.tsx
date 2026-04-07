'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
    ChevronLeft, ChevronRight, Loader2, CheckCircle2, AlertCircle, X,
    Landmark, QrCode, RefreshCw, Tag, Timer, Clock, ArrowRight, ArrowLeft,
    CreditCard, Sparkles, Shield, Battery, Package, Zap,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    SectionCard, ProgressHeader, StickyBottomBar, ErrorBanner,
    PrimaryButton, OutlineButton, FullPageLoader,
} from '@/components/dealer-portal/lead-wizard/shared';

type PaymentStatus = 'UNPAID' | 'QR_GENERATED' | 'PAYMENT_PENDING_CONFIRMATION' | 'PAID' | 'FAILED' | 'EXPIRED';

interface LoanOffer {
    id: string;
    financier_name: string;
    loan_amount: string;
    interest_rate: string;
    tenure_months: number;
    emi: string;
    processing_fee: string | null;
    notes: string | null;
    status: string;
}

export default function DealerOptionsPage() {
    const router = useRouter();
    const params = useParams();
    const leadId = params.id as string;

    const [loading, setLoading] = useState(true);
    const [lead, setLead] = useState<any>(null);
    const [offers, setOffers] = useState<LoanOffer[]>([]);
    const [smStatus, setSmStatus] = useState<string>('');
    const [selectedOffer, setSelectedOffer] = useState<LoanOffer | null>(null);
    const [apiError, setApiError] = useState<string | null>(null);
    const [selecting, setSelecting] = useState<string | null>(null);

    // Payment state
    const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>('UNPAID');
    const [paymentData, setPaymentData] = useState<any>(null);
    const [couponCode, setCouponCode] = useState('');
    const [couponResult, setCouponResult] = useState<any>(null);
    const [couponLoading, setCouponLoading] = useState(false);
    const [generatingQr, setGeneratingQr] = useState(false);
    const [regeneratingQr, setRegeneratingQr] = useState(false);
    const [booking, setBooking] = useState(false);
    const [booked, setBooked] = useState(false);
    const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

    // QR expiry countdown
    const [expirySeconds, setExpirySeconds] = useState(0);

    // ─── Load Data ──────────────────────────────────────────────────────────

    useEffect(() => {
        const load = async () => {
            try {
                const [offersRes, payRes] = await Promise.allSettled([
                    fetch(`/api/leads/${leadId}/loan-offers`),
                    fetch(`/api/kyc/${leadId}/payment-status`),
                ]);

                if (offersRes.status === 'fulfilled') {
                    const data = await offersRes.value.json();
                    if (data.success) {
                        setOffers(data.data.offers || []);
                        setSmStatus(data.data.sm_review_status || '');
                        setLead(data.data.lead || null);
                        const sel = (data.data.offers || []).find((o: LoanOffer) => o.status === 'selected' || o.status === 'booked');
                        if (sel) setSelectedOffer(sel);
                        if (sel?.status === 'booked') setBooked(true);
                    }
                }

                if (payRes.status === 'fulfilled') {
                    const payData = await payRes.value.json();
                    if (payData.success && payData.data) {
                        setPaymentStatus(payData.status || 'UNPAID');
                        setPaymentData({
                            payment_id: payData.data.id,
                            qr_id: payData.data.razorpay_qr_id || '',
                            qr_image_url: payData.data.razorpay_qr_image_url || '',
                            qr_short_url: payData.data.razorpay_qr_short_url || '',
                            expires_at: payData.data.razorpay_qr_expires_at || '',
                            base_amount: Number(payData.data.facilitation_fee_base_amount) || 1500,
                            discount_amount: Number(payData.data.coupon_discount_amount) || 0,
                            final_amount: Number(payData.data.facilitation_fee_final_amount) || 1500,
                            coupon_code: payData.data.coupon_code,
                            razorpay_payment_id: payData.data.razorpay_payment_id,
                        });
                        if (payData.status === 'PAID') setBooked(true);
                    }
                }
            } catch {
                setApiError('Failed to load options');
            } finally {
                setLoading(false);
            }
        };
        load();

        return () => { if (pollIntervalRef.current) clearInterval(pollIntervalRef.current); };
    }, [leadId]);

    // Poll payment status when QR is active
    useEffect(() => {
        if (paymentStatus !== 'QR_GENERATED') {
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
            return;
        }
        pollIntervalRef.current = setInterval(async () => {
            try {
                const res = await fetch(`/api/kyc/${leadId}/payment-status`);
                const data = await res.json();
                if (data.success) {
                    setPaymentStatus(data.status);
                    if (data.status === 'PAID') {
                        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
                        setBooked(true);
                    }
                }
            } catch { /* silent */ }
        }, 5000);

        return () => { if (pollIntervalRef.current) clearInterval(pollIntervalRef.current); };
    }, [paymentStatus, leadId]);

    // QR countdown
    useEffect(() => {
        if (!paymentData?.expires_at || paymentStatus !== 'QR_GENERATED') return;
        const updateCountdown = () => {
            const now = Date.now();
            const exp = new Date(paymentData.expires_at).getTime();
            const remaining = Math.max(0, Math.floor((exp - now) / 1000));
            setExpirySeconds(remaining);
            if (remaining <= 0) setPaymentStatus('EXPIRED');
        };
        updateCountdown();
        const timer = setInterval(updateCountdown, 1000);
        return () => clearInterval(timer);
    }, [paymentData?.expires_at, paymentStatus]);

    // ─── Handlers ───────────────────────────────────────────────────────────

    const handleSelectOffer = async (offer: LoanOffer) => {
        setSelecting(offer.id);
        try {
            const res = await fetch(`/api/leads/${leadId}/loan-offers/${offer.id}/select`, { method: 'POST' });
            const data = await res.json();
            if (data.success) setSelectedOffer(offer);
            else setApiError(data.message || 'Failed to select offer');
        } catch { setApiError('Selection failed'); }
        finally { setSelecting(null); }
    };

    const handleValidateCoupon = async () => {
        if (!couponCode.trim()) return;
        setCouponLoading(true);
        try {
            const res = await fetch(`/api/kyc/${leadId}/validate-coupon`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ couponCode: couponCode.trim() }),
            });
            const data = await res.json();
            setCouponResult(data);
            if (!data.success && !data.valid) setApiError(data.message || 'Invalid coupon');
        } catch { setApiError('Coupon validation failed'); }
        finally { setCouponLoading(false); }
    };

    const handleGenerateQR = async () => {
        setGeneratingQr(true);
        try {
            const res = await fetch(`/api/kyc/${leadId}/create-payment-qr`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ coupon_code: couponResult?.valid ? couponCode : undefined }),
            });
            const data = await res.json();
            if (data.success) {
                setPaymentData(data.data);
                setPaymentStatus('QR_GENERATED');
            } else {
                setApiError(data.message || 'Failed to generate QR');
            }
        } catch { setApiError('QR generation failed'); }
        finally { setGeneratingQr(false); }
    };

    const handleRegenerateQR = async () => {
        setRegeneratingQr(true);
        try {
            const res = await fetch(`/api/kyc/${leadId}/regenerate-payment-qr`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                setPaymentData(data.data);
                setPaymentStatus('QR_GENERATED');
            } else {
                setApiError(data.message || 'Failed to regenerate QR');
            }
        } catch { setApiError('QR regeneration failed'); }
        finally { setRegeneratingQr(false); }
    };

    // ─── Helpers ────────────────────────────────────────────────────────────

    const formatAmount = (amt: string | number) => {
        const num = typeof amt === 'string' ? parseFloat(amt) : amt;
        return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(num);
    };

    const formatCountdown = (seconds: number) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };

    // ─── Render ─────────────────────────────────────────────────────────────

    if (loading) return <FullPageLoader />;

    // Awaiting Review Gate
    if (smStatus && !['options_ready', 'option_booked'].includes(smStatus) && offers.length === 0) {
        return (
            <div className="min-h-screen bg-[#F8F9FB]">
                <div className="max-w-[1200px] mx-auto px-6 py-8">
                    <ProgressHeader title="Loan Options" subtitle={`Lead: ${leadId}`} step={4} onBack={() => router.back()} />
                    <div className="mt-12 max-w-lg mx-auto text-center">
                        <div className="w-24 h-24 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-6">
                            <motion.div
                                animate={{ rotate: 360 }}
                                transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
                            >
                                <RefreshCw className="w-10 h-10 text-[#0047AB]" />
                            </motion.div>
                        </div>
                        <h2 className="text-2xl font-black text-gray-900">Application Under Review</h2>
                        <p className="text-sm text-gray-500 mt-3 max-w-md mx-auto">
                            The iTarang sales team is reviewing your application. You&apos;ll be notified when financing options are ready.
                        </p>
                        <div className="mt-6 inline-flex items-center gap-2 px-4 py-2 bg-amber-50 rounded-full text-xs font-bold text-amber-700">
                            <Clock className="w-3.5 h-3.5" />
                            Status: {smStatus.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                        </div>
                        <div className="mt-8">
                            <button onClick={() => router.push('/dealer-portal/leads')} className="px-8 py-3 bg-[#0047AB] text-white rounded-xl font-bold text-sm hover:bg-[#003580] transition-all flex items-center gap-2 mx-auto">
                                <ArrowLeft className="w-4 h-4" /> Back to Leads
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // Booking Confirmed
    if (booked) {
        return (
            <div className="min-h-screen bg-[#F8F9FB]">
                <div className="max-w-[1200px] mx-auto px-6 py-8">
                    <ProgressHeader title="Loan Options" subtitle={`Lead: ${leadId}`} step={4} onBack={() => router.back()} />
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.5, ease: 'easeOut' }}
                        className="mt-8 max-w-xl mx-auto"
                    >
                        <div className="bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200 rounded-[28px] p-10 text-center">
                            <motion.div
                                initial={{ scale: 0 }}
                                animate={{ scale: 1 }}
                                transition={{ delay: 0.2, type: 'spring', stiffness: 200 }}
                            >
                                <div className="w-24 h-24 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-5">
                                    <Sparkles className="w-12 h-12 text-green-600" />
                                </div>
                            </motion.div>
                            <h2 className="text-2xl font-black text-green-900">Option Booked Successfully!</h2>
                            {selectedOffer && (
                                <div className="mt-4 inline-flex items-center gap-3 px-5 py-3 bg-white rounded-2xl border border-green-200 shadow-sm">
                                    <Landmark className="w-5 h-5 text-[#0047AB]" />
                                    <span className="text-sm font-bold text-gray-900">{selectedOffer.financier_name}</span>
                                    <span className="text-sm text-gray-500">{formatAmount(selectedOffer.loan_amount)}</span>
                                    <span className="text-sm text-gray-500">{selectedOffer.tenure_months} months</span>
                                </div>
                            )}
                            {paymentData?.razorpay_payment_id && (
                                <p className="text-xs text-gray-500 mt-3">Payment ID: {paymentData.razorpay_payment_id}</p>
                            )}
                            <div className="mt-8">
                                <button onClick={() => router.push('/dealer-portal/leads')} className="px-8 py-3 bg-[#0047AB] text-white rounded-xl font-bold text-sm hover:bg-[#003580] transition-all flex items-center gap-2 mx-auto">
                                    <ArrowLeft className="w-4 h-4" /> Back to Leads
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#F8F9FB]">
            <div className="max-w-[1200px] mx-auto px-6 py-8 pb-40">
                <ProgressHeader title="Loan Options" subtitle={`Lead: ${leadId}`} step={4} onBack={() => router.back()} />
                <ErrorBanner message={apiError} onDismiss={() => setApiError(null)} />

                <main className="grid grid-cols-1 gap-6">
                    {/* ─── Selected Product ───────────────────────── */}
                    {lead && (
                        <div className="bg-gradient-to-r from-[#0047AB] to-[#1D4ED8] rounded-[24px] p-6 text-white">
                            <div className="flex items-center gap-4">
                                <div className="w-14 h-14 bg-white/10 rounded-2xl flex items-center justify-center">
                                    <Battery className="w-7 h-7" />
                                </div>
                                <div className="flex-1">
                                    <p className="text-white/60 text-xs font-bold uppercase tracking-widest">Selected Product</p>
                                    <h3 className="text-lg font-black mt-0.5">
                                        {lead.product_name || lead.primary_product_name || 'EV Battery'}
                                    </h3>
                                </div>
                                <div className="flex gap-6 text-sm">
                                    <div>
                                        <p className="text-white/50 text-xs font-bold">Category</p>
                                        <p className="font-bold">{lead.asset_model_label || lead.asset_model || '-'}</p>
                                    </div>
                                    <div>
                                        <p className="text-white/50 text-xs font-bold">SKU</p>
                                        <p className="font-bold">{lead.product_sku || '-'}</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ─── Available Financing Options ────────────── */}
                    <SectionCard title="Available Financing Options">
                        {offers.length === 0 ? (
                            <div className="text-center py-10">
                                <Clock className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                                <p className="text-sm text-gray-500 font-medium">No offers available yet. The sales team will add options after review.</p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {offers.map(offer => {
                                    const isSelected = selectedOffer?.id === offer.id;
                                    return (
                                        <motion.div
                                            key={offer.id}
                                            whileHover={{ y: -2 }}
                                            className={`relative p-6 rounded-2xl border-2 transition-all cursor-pointer ${
                                                isSelected
                                                    ? 'border-[#0047AB] bg-blue-50/50 shadow-[0_0_0_4px_rgba(0,71,171,0.1)]'
                                                    : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-md'
                                            }`}
                                            onClick={() => !isSelected && handleSelectOffer(offer)}
                                        >
                                            {isSelected && (
                                                <div className="absolute top-4 right-4 w-6 h-6 bg-[#0047AB] rounded-full flex items-center justify-center">
                                                    <CheckCircle2 className="w-4 h-4 text-white" />
                                                </div>
                                            )}

                                            <div className="flex items-center gap-3 mb-4">
                                                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isSelected ? 'bg-[#0047AB] text-white' : 'bg-gray-100 text-gray-500'}`}>
                                                    <Landmark className="w-5 h-5" />
                                                </div>
                                                <div>
                                                    <p className="font-black text-gray-900 text-sm">{offer.financier_name}</p>
                                                    <p className="text-xs text-gray-500">Loan offer</p>
                                                </div>
                                            </div>

                                            <div className="text-2xl font-black text-gray-900 mb-4">
                                                {formatAmount(offer.loan_amount)}
                                            </div>

                                            <div className="grid grid-cols-3 gap-3">
                                                <div className="bg-gray-50 rounded-xl p-3">
                                                    <p className="text-[10px] text-gray-500 font-bold uppercase">Rate</p>
                                                    <p className="text-sm font-black text-gray-900">{offer.interest_rate}%</p>
                                                </div>
                                                <div className="bg-gray-50 rounded-xl p-3">
                                                    <p className="text-[10px] text-gray-500 font-bold uppercase">Tenure</p>
                                                    <p className="text-sm font-black text-gray-900">{offer.tenure_months} mo</p>
                                                </div>
                                                <div className="bg-gray-50 rounded-xl p-3">
                                                    <p className="text-[10px] text-gray-500 font-bold uppercase">EMI</p>
                                                    <p className="text-sm font-black text-gray-900">{formatAmount(offer.emi)}</p>
                                                </div>
                                            </div>

                                            {offer.processing_fee && (
                                                <p className="text-xs text-gray-500 mt-3">
                                                    Processing fee: {formatAmount(offer.processing_fee)}
                                                </p>
                                            )}
                                            {offer.notes && (
                                                <p className="text-xs text-gray-400 mt-1 italic">{offer.notes}</p>
                                            )}

                                            {!isSelected && (
                                                <button
                                                    disabled={selecting === offer.id}
                                                    className="mt-4 w-full py-2.5 border-2 border-[#0047AB] rounded-xl text-sm font-bold text-[#0047AB] hover:bg-blue-50 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                                                >
                                                    {selecting === offer.id ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                                                    Select This Option <ChevronRight className="w-4 h-4" />
                                                </button>
                                            )}
                                        </motion.div>
                                    );
                                })}
                            </div>
                        )}
                    </SectionCard>

                    {/* ─── Facilitation Fee Payment ───────────────── */}
                    {selectedOffer && (
                        <SectionCard title="Facilitation Fee Payment">
                            {/* Coupon */}
                            <div className="bg-[#F8FAFF] rounded-2xl p-5 border border-blue-100 mb-6">
                                <p className="text-sm font-bold text-gray-900 mb-3 flex items-center gap-2">
                                    <Tag className="w-4 h-4 text-[#0047AB]" /> Apply Coupon Code
                                </p>
                                <div className="flex gap-3">
                                    <input
                                        type="text"
                                        value={couponCode}
                                        onChange={e => setCouponCode(e.target.value.toUpperCase())}
                                        placeholder="Enter coupon code"
                                        maxLength={20}
                                        className="flex-1 h-11 px-4 bg-white border-2 border-[#EBEBEB] rounded-xl outline-none text-sm focus:border-[#1D4ED8] transition-all"
                                    />
                                    <button
                                        onClick={handleValidateCoupon}
                                        disabled={couponLoading || !couponCode.trim()}
                                        className="px-6 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] transition-all disabled:opacity-50 flex items-center gap-2"
                                    >
                                        {couponLoading && <Loader2 className="w-4 h-4 animate-spin" />} Apply
                                    </button>
                                </div>
                                {couponResult && (couponResult.success || couponResult.valid) && (
                                    <div className="mt-3 flex items-center gap-2 text-sm font-medium text-green-700">
                                        <CheckCircle2 className="w-4 h-4" />
                                        Coupon applied — {couponResult.coupon?.value ? `${formatAmount(couponResult.coupon.value)} off` : 'Discount applied'}
                                    </div>
                                )}
                            </div>

                            {/* Payment / QR */}
                            {paymentStatus === 'UNPAID' && (
                                <div className="text-center py-6">
                                    <button
                                        onClick={handleGenerateQR}
                                        disabled={generatingQr}
                                        className="px-10 py-4 bg-gradient-to-r from-[#0047AB] to-[#1D4ED8] text-white rounded-2xl font-bold text-sm hover:shadow-lg transition-all flex items-center gap-3 mx-auto disabled:opacity-50"
                                    >
                                        {generatingQr ? <Loader2 className="w-5 h-5 animate-spin" /> : <QrCode className="w-5 h-5" />}
                                        Generate Payment QR
                                    </button>
                                </div>
                            )}

                            {(paymentStatus === 'QR_GENERATED' || paymentStatus === 'PAYMENT_PENDING_CONFIRMATION') && paymentData && (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
                                    {/* QR Code */}
                                    <div className="flex flex-col items-center">
                                        <div className="bg-white rounded-2xl border-2 border-gray-100 p-6 shadow-sm">
                                            {paymentData.qr_image_url ? (
                                                <img src={paymentData.qr_image_url} alt="Payment QR" className="w-48 h-48 mx-auto" />
                                            ) : (
                                                <div className="w-48 h-48 bg-gray-100 rounded-xl flex items-center justify-center">
                                                    <QrCode className="w-16 h-16 text-gray-300" />
                                                </div>
                                            )}
                                        </div>
                                        <p className="text-sm text-gray-500 mt-3">Scan with any UPI app</p>

                                        {/* Countdown */}
                                        <div className={`mt-3 flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold ${
                                            expirySeconds > 120 ? 'bg-green-50 text-green-700' :
                                            expirySeconds > 30 ? 'bg-amber-50 text-amber-700' :
                                            'bg-red-50 text-red-700'
                                        }`}>
                                            <Timer className="w-3.5 h-3.5" />
                                            Expires in {formatCountdown(expirySeconds)}
                                        </div>

                                        {/* Checking payment pulse */}
                                        <div className="mt-3 flex items-center gap-2 text-xs text-gray-400">
                                            <motion.div
                                                animate={{ opacity: [1, 0.3, 1] }}
                                                transition={{ duration: 1.5, repeat: Infinity }}
                                                className="w-2 h-2 bg-[#0047AB] rounded-full"
                                            />
                                            Checking payment status...
                                        </div>
                                    </div>

                                    {/* Amount Breakdown */}
                                    <div className="bg-[#F8FAFF] rounded-2xl p-6 border border-blue-100">
                                        <p className="text-sm font-black text-gray-900 mb-4">Payment Summary</p>
                                        <div className="space-y-3">
                                            <div className="flex justify-between text-sm">
                                                <span className="text-gray-500">Facilitation Fee</span>
                                                <span className="font-bold text-gray-900">{formatAmount(paymentData.base_amount || 1500)}</span>
                                            </div>
                                            {paymentData.discount_amount > 0 && (
                                                <div className="flex justify-between text-sm">
                                                    <span className="text-green-600">Coupon Discount</span>
                                                    <span className="font-bold text-green-600">-{formatAmount(paymentData.discount_amount)}</span>
                                                </div>
                                            )}
                                            <div className="border-t border-blue-200 pt-3 flex justify-between">
                                                <span className="font-black text-gray-900">Total Payable</span>
                                                <span className="text-xl font-black text-[#0047AB]">{formatAmount(paymentData.final_amount || paymentData.base_amount || 1500)}</span>
                                            </div>
                                        </div>

                                        <button
                                            onClick={handleRegenerateQR}
                                            disabled={regeneratingQr}
                                            className="mt-6 w-full py-2.5 border-2 border-gray-200 rounded-xl text-sm font-bold text-gray-600 hover:bg-gray-50 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                                        >
                                            {regeneratingQr ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                                            Regenerate QR
                                        </button>
                                    </div>
                                </div>
                            )}

                            {paymentStatus === 'EXPIRED' && (
                                <div className="text-center py-8">
                                    <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
                                        <Clock className="w-8 h-8 text-red-400" />
                                    </div>
                                    <p className="text-lg font-bold text-gray-900">QR Code Expired</p>
                                    <p className="text-sm text-gray-500 mt-1">Please regenerate a new QR code to continue.</p>
                                    <button
                                        onClick={handleRegenerateQR}
                                        disabled={regeneratingQr}
                                        className="mt-4 px-8 py-3 bg-[#0047AB] text-white rounded-xl font-bold text-sm hover:bg-[#003580] transition-all flex items-center gap-2 mx-auto disabled:opacity-50"
                                    >
                                        {regeneratingQr ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                                        Regenerate QR
                                    </button>
                                </div>
                            )}

                            {paymentStatus === 'FAILED' && (
                                <div className="text-center py-8">
                                    <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
                                        <AlertCircle className="w-8 h-8 text-red-400" />
                                    </div>
                                    <p className="text-lg font-bold text-gray-900">Payment Failed</p>
                                    <p className="text-sm text-gray-500 mt-1">Please try again with a new QR code.</p>
                                    <button
                                        onClick={handleRegenerateQR}
                                        disabled={regeneratingQr}
                                        className="mt-4 px-8 py-3 bg-[#0047AB] text-white rounded-xl font-bold text-sm hover:bg-[#003580] transition-all flex items-center gap-2 mx-auto disabled:opacity-50"
                                    >
                                        {regeneratingQr ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                                        Try Again
                                    </button>
                                </div>
                            )}
                        </SectionCard>
                    )}
                </main>

                {/* ─── Bottom Bar ──────────────────────────────── */}
                <StickyBottomBar>
                    <OutlineButton onClick={() => router.push('/dealer-portal/leads')}>
                        <ArrowLeft className="w-4 h-4" /> Back to Leads
                    </OutlineButton>
                </StickyBottomBar>
            </div>
        </div>
    );
}
