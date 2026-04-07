'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
    ChevronLeft, Loader2, CheckCircle2, AlertCircle, X,
    Landmark, QrCode, RefreshCw, Tag, Timer, Clock, ArrowRight
} from 'lucide-react';
import { useAuth } from '@/components/auth/AuthProvider';

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
    const { user } = useAuth();

    const [loading, setLoading] = useState(true);
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
    const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        const load = async () => {
            try {
                const res = await fetch(`/api/leads/${leadId}/loan-offers`);
                const data = await res.json();
                if (data.success) {
                    setOffers(data.data.offers);
                    setSmStatus(data.data.sm_review_status);
                    const sel = data.data.offers.find((o: LoanOffer) => o.status === 'selected' || o.status === 'booked');
                    if (sel) setSelectedOffer(sel);
                }
                // Load existing payment status
                const payRes = await fetch(`/api/kyc/${leadId}/payment-status`);
                const payData = await payRes.json();
                if (payData.success && payData.data) {
                    setPaymentStatus(payData.status || 'UNPAID');
                    setPaymentData(payData.data ? {
                        payment_id: payData.data.id,
                        qr_id: payData.data.razorpay_qr_id || '',
                        qr_image_url: payData.data.razorpay_qr_image_url || '',
                        qr_short_url: payData.data.razorpay_qr_short_url || '',
                        expires_at: payData.data.razorpay_qr_expires_at || '',
                        base_amount: Number(payData.data.facilitation_fee_base_amount) || 1500,
                        discount_amount: Number(payData.data.coupon_discount_amount) || 0,
                        final_amount: Number(payData.data.facilitation_fee_final_amount) || 1500,
                        coupon_code: payData.data.coupon_code,
                        facilitation_fee_status: payData.status,
                        razorpay_payment_id: payData.data.razorpay_payment_id,
                    } : null);
                }
            } catch { setApiError('Failed to load options'); }
            finally { setLoading(false); }
        };
        load();
    }, [leadId]);

    // Poll payment status every 5s when QR is active
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
                        // Auto-book
                        if (selectedOffer) {
                            await fetch(`/api/leads/${leadId}/loan-offers/${selectedOffer.id}/book`, { method: 'POST' });
                            setSmStatus('option_booked');
                        }
                    }
                    if (data.status === 'EXPIRED') {
                        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
                    }
                }
            } catch { /* silent */ }
        }, 5000);
        return () => { if (pollIntervalRef.current) clearInterval(pollIntervalRef.current); };
    }, [paymentStatus, leadId, selectedOffer]);

    const handleSelectOffer = async (offer: LoanOffer) => {
        setSelecting(offer.id);
        try {
            const res = await fetch(`/api/leads/${leadId}/loan-offers/${offer.id}/select`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                setSelectedOffer(offer);
                setOffers(prev => prev.map(o => ({ ...o, status: o.id === offer.id ? 'selected' : o.status === 'selected' ? 'offered' : o.status })));
            } else { setApiError(data.error?.message || 'Failed to select'); }
        } catch { setApiError('Request failed'); }
        finally { setSelecting(null); }
    };

    const handleValidateCoupon = async () => {
        if (!couponCode.trim()) return;
        setCouponLoading(true); setCouponResult(null);
        try {
            const res = await fetch(`/api/kyc/${leadId}/validate-coupon`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ couponCode: couponCode.trim() }),
            });
            setCouponResult(await res.json());
        } catch { setCouponResult({ valid: false, message: 'Network error' }); }
        finally { setCouponLoading(false); }
    };

    const handleGenerateQr = async () => {
        if (!selectedOffer) return;
        setGeneratingQr(true); setApiError(null);
        try {
            const res = await fetch(`/api/kyc/${leadId}/create-payment-qr`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    coupon_code: couponResult?.valid ? couponResult.coupon_code : null,
                    coupon_id: couponResult?.valid ? couponResult.coupon_id : null,
                }),
            });
            const data = await res.json();
            if (data.success) { setPaymentData(data.data); setPaymentStatus('QR_GENERATED'); }
            else { setApiError(data.error?.message || 'Failed to generate QR'); }
        } catch { setApiError('Failed to generate payment QR'); }
        finally { setGeneratingQr(false); }
    };

    const handleRegenerateQr = async () => {
        setRegeneratingQr(true);
        try {
            const res = await fetch(`/api/kyc/${leadId}/regenerate-payment-qr`, { method: 'POST' });
            const data = await res.json();
            if (data.success) { setPaymentData(prev => ({ ...prev, ...data.data })); setPaymentStatus('QR_GENERATED'); }
            else { setApiError(data.error?.message || 'Failed to regenerate QR'); }
        } catch { setApiError('Failed'); }
        finally { setRegeneratingQr(false); }
    };

    if (loading) return <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB]"><Loader2 className="w-10 h-10 animate-spin text-[#1D4ED8]" /></div>;

    const feePaid = paymentStatus === 'PAID' || smStatus === 'option_booked';

    if (smStatus !== 'options_ready' && smStatus !== 'option_booked') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB]">
                <div className="text-center max-w-sm">
                    <Clock className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                    <h2 className="text-xl font-bold text-gray-900">Awaiting Itarang Review</h2>
                    <p className="text-sm text-gray-500 mt-2">Our team is reviewing your documents and working with financiers. You'll be notified when loan options are ready.</p>
                    <button onClick={() => router.push('/dealer-portal/leads')} className="mt-6 px-6 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold">
                        Back to Leads
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#F8F9FB]">
            <div className="max-w-[900px] mx-auto px-6 py-8 pb-32">
                <header className="mb-8 flex items-center gap-4">
                    <button onClick={() => router.back()} className="p-2 hover:bg-white rounded-lg transition-colors">
                        <ChevronLeft className="w-6 h-6 text-gray-900" />
                    </button>
                    <div>
                        <h1 className="text-[28px] font-black text-gray-900">Loan Options</h1>
                        <p className="text-sm text-gray-500 mt-0.5">Select the best option for your customer</p>
                    </div>
                    <div className="ml-auto">
                        <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest text-right mb-1.5">Workflow Progress</p>
                        <div className="flex items-center gap-4">
                            <span className="text-xs font-bold text-[#1D4ED8] whitespace-nowrap">Step 4 of 5</span>
                            <div className="flex gap-2">
                                {[1, 2, 3, 4, 5].map(s => (
                                    <div key={s} className={`h-[6px] w-[40px] rounded-full ${s <= 4 ? 'bg-[#0047AB]' : 'bg-gray-200'}`} />
                                ))}
                            </div>
                        </div>
                    </div>
                </header>

                {apiError && (
                    <div className="mb-6 bg-red-50 border border-red-200 p-4 rounded-xl flex items-center justify-between">
                        <span className="text-sm text-red-700 font-medium flex items-center gap-2"><AlertCircle className="w-4 h-4" />{apiError}</span>
                        <button onClick={() => setApiError(null)}><X className="w-4 h-4" /></button>
                    </div>
                )}

                {/* BOOKING SUCCESS */}
                {smStatus === 'option_booked' && (
                    <div className="mb-6 p-8 bg-green-50 border border-green-200 rounded-2xl text-center">
                        <CheckCircle2 className="w-12 h-12 text-green-600 mx-auto mb-3" />
                        <p className="text-xl font-bold text-green-800">Option Booked!</p>
                        <p className="text-sm text-green-600 mt-1">Payment received. Itarang will proceed with the loan processing.</p>
                        <button onClick={() => router.push('/dealer-portal/leads')} className="mt-6 px-8 py-3 bg-[#0047AB] text-white rounded-xl font-bold text-sm">
                            Back to Leads
                        </button>
                    </div>
                )}

                {/* LOAN OFFER CARDS */}
                <div className="space-y-4 mb-8">
                    {offers.map(offer => {
                        const isSelected = selectedOffer?.id === offer.id;
                        return (
                            <div key={offer.id}
                                className={`bg-white rounded-2xl border-2 shadow-sm p-6 transition-all ${isSelected ? 'border-[#0047AB] shadow-blue-100' : 'border-gray-100 hover:border-gray-200'}`}>
                                <div className="flex items-start justify-between mb-5">
                                    <div className="flex items-center gap-3">
                                        <div className="w-11 h-11 bg-blue-50 rounded-xl flex items-center justify-center">
                                            <Landmark className="w-5 h-5 text-[#0047AB]" />
                                        </div>
                                        <div>
                                            <p className="font-black text-gray-900 text-lg">{offer.financier_name}</p>
                                            {isSelected && <span className="text-xs font-bold text-[#0047AB] bg-blue-50 px-2 py-0.5 rounded-full">Selected</span>}
                                            {offer.status === 'booked' && <span className="text-xs font-bold text-green-700 bg-green-50 px-2 py-0.5 rounded-full">Booked</span>}
                                        </div>
                                    </div>
                                    <p className="text-2xl font-black text-[#0047AB]">&#8377;{Number(offer.loan_amount).toLocaleString('en-IN')}</p>
                                </div>
                                <div className="grid grid-cols-4 gap-4 mb-5">
                                    <div className="bg-gray-50 rounded-xl p-3">
                                        <p className="text-xs text-gray-400 mb-1">Interest Rate</p>
                                        <p className="text-sm font-black text-gray-900">{offer.interest_rate}% p.a.</p>
                                    </div>
                                    <div className="bg-gray-50 rounded-xl p-3">
                                        <p className="text-xs text-gray-400 mb-1">Tenure</p>
                                        <p className="text-sm font-black text-gray-900">{offer.tenure_months} months</p>
                                    </div>
                                    <div className="bg-gray-50 rounded-xl p-3">
                                        <p className="text-xs text-gray-400 mb-1">Monthly EMI</p>
                                        <p className="text-sm font-black text-gray-900">&#8377;{Number(offer.emi).toLocaleString('en-IN')}</p>
                                    </div>
                                    <div className="bg-gray-50 rounded-xl p-3">
                                        <p className="text-xs text-gray-400 mb-1">Processing Fee</p>
                                        <p className="text-sm font-black text-gray-900">{offer.processing_fee ? `₹${Number(offer.processing_fee).toLocaleString('en-IN')}` : 'Nil'}</p>
                                    </div>
                                </div>
                                {offer.notes && <p className="text-xs text-gray-400 mb-4">{offer.notes}</p>}
                                {!feePaid && offer.status !== 'booked' && (
                                    <button
                                        onClick={() => handleSelectOffer(offer)}
                                        disabled={!!selecting}
                                        className={`w-full py-3 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 ${isSelected ? 'bg-[#0047AB] text-white' : 'border-2 border-[#0047AB] text-[#0047AB] hover:bg-blue-50'}`}>
                                        {selecting === offer.id ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                                        {isSelected ? 'Selected — Pay Facilitation Fee Below' : 'Select This Option'}
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>

                {/* PAYMENT SECTION — shown only after offer selected and not yet paid */}
                {selectedOffer && !feePaid && (
                    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
                        <h3 className="text-sm font-black text-gray-900 uppercase tracking-wider mb-6">Facilitation Fee Payment</h3>

                        {paymentStatus === 'UNPAID' || paymentStatus === 'FAILED' ? (
                            <div className="space-y-4">
                                <p className="text-sm text-gray-500">Pay the facilitation fee to confirm and book the selected loan option.</p>
                                {/* Coupon */}
                                <div className="flex gap-3">
                                    <input value={couponCode} onChange={e => setCouponCode(e.target.value.toUpperCase())}
                                        placeholder="Coupon code (optional)"
                                        className="flex-1 h-11 px-4 bg-gray-50 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]" />
                                    <button onClick={handleValidateCoupon} disabled={couponLoading || !couponCode.trim()}
                                        className="px-5 py-2.5 border-2 border-[#0047AB] text-[#0047AB] rounded-xl text-sm font-bold disabled:opacity-40 flex items-center gap-1.5">
                                        {couponLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Tag className="w-4 h-4" />} Apply
                                    </button>
                                </div>
                                {couponResult && (
                                    <p className={`text-xs font-medium ${couponResult.valid ? 'text-green-600' : 'text-red-500'}`}>
                                        {couponResult.valid ? `✓ Coupon applied — save ₹${couponResult.discount_amount}` : `✗ ${couponResult.message}`}
                                    </p>
                                )}
                                <button onClick={handleGenerateQr} disabled={generatingQr}
                                    className="w-full py-3.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] disabled:opacity-50 flex items-center justify-center gap-2">
                                    {generatingQr ? <Loader2 className="w-4 h-4 animate-spin" /> : <QrCode className="w-4 h-4" />}
                                    Generate Payment QR
                                </button>
                            </div>
                        ) : paymentStatus === 'QR_GENERATED' && paymentData ? (
                            <div className="space-y-6">
                                <div className="flex flex-col md:flex-row gap-8">
                                    <div className="flex flex-col items-center">
                                        <div className="bg-white p-4 rounded-2xl border-2 border-gray-100 shadow-sm">
                                            {paymentData.qr_image_url ? (
                                                <img src={paymentData.qr_image_url} alt="Payment QR" className="w-[200px] h-[200px] object-contain" />
                                            ) : (
                                                <div className="w-[200px] h-[200px] flex items-center justify-center bg-gray-50 rounded-xl">
                                                    <QrCode className="w-16 h-16 text-gray-300" />
                                                </div>
                                            )}
                                        </div>
                                        <p className="text-xs text-gray-400 mt-2">Scan with any UPI app</p>
                                        {paymentData.qr_short_url && (
                                            <a href={paymentData.qr_short_url} target="_blank" rel="noopener noreferrer"
                                                className="text-xs text-[#0047AB] font-medium mt-1 hover:underline">Open UPI link</a>
                                        )}
                                    </div>
                                    <div className="flex-1 space-y-4">
                                        <div className="p-4 bg-gray-50 rounded-xl space-y-3">
                                            <div className="flex justify-between text-sm">
                                                <span className="text-gray-500">Base Amount</span>
                                                <span className="font-bold">&#8377;{paymentData.base_amount}</span>
                                            </div>
                                            {paymentData.discount_amount > 0 && (
                                                <div className="flex justify-between text-sm">
                                                    <span className="text-green-600">Discount</span>
                                                    <span className="font-bold text-green-600">-&#8377;{paymentData.discount_amount}</span>
                                                </div>
                                            )}
                                            <div className="border-t border-gray-200 pt-3 flex justify-between">
                                                <span className="font-bold text-gray-900">Amount to Pay</span>
                                                <span className="text-xl font-black text-[#0047AB]">&#8377;{paymentData.final_amount}</span>
                                            </div>
                                        </div>
                                        {paymentData.expires_at && (
                                            <div className="flex items-center gap-2 text-xs text-amber-600">
                                                <Timer className="w-4 h-4" /> QR expires at {new Date(paymentData.expires_at).toLocaleTimeString()}
                                            </div>
                                        )}
                                        <div className="flex items-center gap-3 p-4 bg-blue-50 border border-blue-200 rounded-xl">
                                            <Loader2 className="w-5 h-5 animate-spin text-[#0047AB]" />
                                            <div>
                                                <p className="text-sm font-bold text-[#0047AB]">Waiting for payment...</p>
                                                <p className="text-xs text-blue-500">Will be detected automatically</p>
                                            </div>
                                        </div>
                                        <button onClick={handleRegenerateQr} disabled={regeneratingQr}
                                            className="text-xs text-gray-400 hover:text-[#0047AB] flex items-center gap-1 transition-colors">
                                            {regeneratingQr ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                                            QR expired? Generate new one
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ) : paymentStatus === 'EXPIRED' ? (
                            <div className="space-y-4">
                                <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-3">
                                    <Clock className="w-5 h-5 text-amber-600" />
                                    <p className="text-sm font-medium text-amber-800">QR expired. Generate a new one.</p>
                                </div>
                                <button onClick={handleRegenerateQr} disabled={regeneratingQr}
                                    className="px-6 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold flex items-center gap-2">
                                    {regeneratingQr ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Generate New QR
                                </button>
                            </div>
                        ) : null}
                    </div>
                )}
            </div>
        </div>
    );
}
