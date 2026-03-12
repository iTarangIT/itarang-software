'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
    ChevronLeft, Loader2, Plus, Trash2, CheckCircle2,
    AlertCircle, X, Landmark, ChevronRight
} from 'lucide-react';

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

const emptyForm = {
    financier_name: '',
    loan_amount: '',
    interest_rate: '',
    tenure_months: '',
    emi: '',
    processing_fee: '',
    notes: '',
};

function calcEmi(principal: number, rateAnnual: number, months: number): number {
    if (!principal || !rateAnnual || !months) return 0;
    const r = rateAnnual / 12 / 100;
    return Math.round((principal * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1));
}

export default function SMOptionsPage() {
    const router = useRouter();
    const params = useParams();
    const leadId = params.id as string;

    const [loading, setLoading] = useState(true);
    const [offers, setOffers] = useState<LoanOffer[]>([]);
    const [smStatus, setSmStatus] = useState<string>('');
    const [apiError, setApiError] = useState<string | null>(null);
    const [successMsg, setSuccessMsg] = useState<string | null>(null);
    const [form, setForm] = useState(emptyForm);
    const [submittingOffer, setSubmittingOffer] = useState(false);
    const [submittingOptions, setSubmittingOptions] = useState(false);
    const [showForm, setShowForm] = useState(false);

    useEffect(() => {
        const load = async () => {
            try {
                const res = await fetch(`/api/sm/leads/${leadId}/loan-offers`);
                const data = await res.json();
                if (data.success) {
                    setOffers(data.data.offers);
                }
                const leadRes = await fetch(`/api/leads/${leadId}`);
                const leadData = await leadRes.json();
                if (leadData.success) setSmStatus(leadData.data.sm_review_status);
            } catch { setApiError('Failed to load data'); }
            finally { setLoading(false); }
        };
        load();
    }, [leadId]);

    const updateField = (field: string, value: string) => {
        setForm(prev => {
            const next = { ...prev, [field]: value };
            // Auto-calc EMI
            const p = parseFloat(field === 'loan_amount' ? value : next.loan_amount);
            const r = parseFloat(field === 'interest_rate' ? value : next.interest_rate);
            const m = parseInt(field === 'tenure_months' ? value : next.tenure_months);
            if (p > 0 && r > 0 && m > 0 && field !== 'emi') {
                next.emi = calcEmi(p, r, m).toString();
            }
            return next;
        });
    };

    const handleAddOffer = async () => {
        if (!form.financier_name || !form.loan_amount || !form.interest_rate || !form.tenure_months || !form.emi) {
            setApiError('Fill all required fields'); return;
        }
        setSubmittingOffer(true);
        try {
            const res = await fetch(`/api/sm/leads/${leadId}/loan-offers`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    financier_name: form.financier_name,
                    loan_amount: parseFloat(form.loan_amount),
                    interest_rate: parseFloat(form.interest_rate),
                    tenure_months: parseInt(form.tenure_months),
                    emi: parseFloat(form.emi),
                    processing_fee: form.processing_fee ? parseFloat(form.processing_fee) : undefined,
                    notes: form.notes || undefined,
                }),
            });
            const data = await res.json();
            if (data.success) {
                const offersRes = await fetch(`/api/sm/leads/${leadId}/loan-offers`);
                const offersData = await offersRes.json();
                if (offersData.success) setOffers(offersData.data.offers);
                setForm(emptyForm);
                setShowForm(false);
                setSuccessMsg('Loan offer added');
            } else { setApiError(data.error?.message || 'Failed to add offer'); }
        } catch { setApiError('Request failed'); }
        finally { setSubmittingOffer(false); }
    };

    const handleShareWithDealer = async () => {
        if (offers.length === 0) { setApiError('Add at least one loan offer first'); return; }
        setSubmittingOptions(true);
        try {
            const res = await fetch(`/api/sm/leads/${leadId}/submit-options`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                setSmStatus('options_ready');
                setSuccessMsg('Loan options shared with dealer. They will now see these options and can select one.');
            } else { setApiError(data.error?.message || 'Failed to share'); }
        } catch { setApiError('Request failed'); }
        finally { setSubmittingOptions(false); }
    };

    if (loading) return <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB]"><Loader2 className="w-10 h-10 animate-spin text-[#1D4ED8]" /></div>;

    return (
        <div className="min-h-screen bg-[#F8F9FB]">
            <div className="max-w-[900px] mx-auto px-6 py-8 pb-32">
                <header className="mb-8 flex items-center gap-4">
                    <button onClick={() => router.back()} className="p-2 hover:bg-white rounded-lg transition-colors">
                        <ChevronLeft className="w-6 h-6 text-gray-900" />
                    </button>
                    <div>
                        <h1 className="text-[28px] font-black text-gray-900">Loan Offers</h1>
                        <p className="text-sm text-gray-500 mt-0.5">Enter financing options from vendors for Lead {leadId}</p>
                    </div>
                </header>

                {apiError && (
                    <div className="mb-6 bg-red-50 border border-red-200 p-4 rounded-xl flex items-center justify-between">
                        <span className="text-sm text-red-700 font-medium flex items-center gap-2"><AlertCircle className="w-4 h-4" />{apiError}</span>
                        <button onClick={() => setApiError(null)}><X className="w-4 h-4" /></button>
                    </div>
                )}
                {successMsg && (
                    <div className="mb-6 bg-green-50 border border-green-200 p-4 rounded-xl flex items-center justify-between">
                        <span className="text-sm text-green-700 font-medium flex items-center gap-2"><CheckCircle2 className="w-4 h-4" />{successMsg}</span>
                        <button onClick={() => setSuccessMsg(null)}><X className="w-4 h-4" /></button>
                    </div>
                )}

                {smStatus === 'options_ready' || smStatus === 'option_booked' ? (
                    <div className="mb-6 p-4 bg-purple-50 border border-purple-200 rounded-xl text-sm font-medium text-purple-700 flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4" />
                        Options have been shared with the dealer.
                        {smStatus === 'option_booked' && ' The dealer has booked an option.'}
                    </div>
                ) : null}

                {/* Existing offers */}
                {offers.length > 0 && (
                    <div className="space-y-4 mb-6">
                        {offers.map((offer, i) => (
                            <div key={offer.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
                                <div className="flex items-start justify-between mb-4">
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
                                            <Landmark className="w-5 h-5 text-[#0047AB]" />
                                        </div>
                                        <div>
                                            <p className="font-black text-gray-900">{offer.financier_name}</p>
                                            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${offer.status === 'booked' ? 'bg-green-50 text-green-700' : offer.status === 'selected' ? 'bg-blue-50 text-blue-700' : offer.status === 'offered' ? 'bg-purple-50 text-purple-700' : 'bg-gray-50 text-gray-500'}`}>
                                                {offer.status}
                                            </span>
                                        </div>
                                    </div>
                                    <p className="text-xl font-black text-[#0047AB]">&#8377;{Number(offer.loan_amount).toLocaleString('en-IN')}</p>
                                </div>
                                <div className="grid grid-cols-4 gap-4">
                                    <div><p className="text-xs text-gray-400 mb-0.5">Interest Rate</p><p className="text-sm font-bold">{offer.interest_rate}% p.a.</p></div>
                                    <div><p className="text-xs text-gray-400 mb-0.5">Tenure</p><p className="text-sm font-bold">{offer.tenure_months} months</p></div>
                                    <div><p className="text-xs text-gray-400 mb-0.5">EMI</p><p className="text-sm font-bold">&#8377;{Number(offer.emi).toLocaleString('en-IN')}/mo</p></div>
                                    <div><p className="text-xs text-gray-400 mb-0.5">Processing Fee</p><p className="text-sm font-bold">{offer.processing_fee ? `₹${Number(offer.processing_fee).toLocaleString('en-IN')}` : '—'}</p></div>
                                </div>
                                {offer.notes && <p className="mt-3 text-xs text-gray-400">{offer.notes}</p>}
                            </div>
                        ))}
                    </div>
                )}

                {/* Add offer form */}
                {!showForm ? (
                    <button onClick={() => setShowForm(true)}
                        className="w-full py-4 border-2 border-dashed border-gray-200 rounded-2xl text-sm font-bold text-gray-400 hover:border-[#0047AB] hover:text-[#0047AB] transition-colors flex items-center justify-center gap-2">
                        <Plus className="w-5 h-5" /> Add Loan Offer
                    </button>
                ) : (
                    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
                        <div className="flex items-center justify-between mb-6">
                            <h3 className="font-black text-gray-900">New Loan Offer</h3>
                            <button onClick={() => setShowForm(false)}><X className="w-5 h-5 text-gray-400" /></button>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="col-span-2">
                                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Financier Name *</label>
                                <input value={form.financier_name} onChange={e => updateField('financier_name', e.target.value)}
                                    placeholder="e.g. Mahindra Finance, HDFC Bank" className="w-full h-11 px-4 bg-gray-50 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]" />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Loan Amount (₹) *</label>
                                <input value={form.loan_amount} onChange={e => updateField('loan_amount', e.target.value.replace(/\D/g, ''))}
                                    placeholder="e.g. 80000" className="w-full h-11 px-4 bg-gray-50 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8] font-mono" />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Interest Rate (% p.a.) *</label>
                                <input value={form.interest_rate} onChange={e => updateField('interest_rate', e.target.value)}
                                    placeholder="e.g. 14.5" className="w-full h-11 px-4 bg-gray-50 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8] font-mono" />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Tenure (months) *</label>
                                <input value={form.tenure_months} onChange={e => updateField('tenure_months', e.target.value.replace(/\D/g, ''))}
                                    placeholder="e.g. 24" className="w-full h-11 px-4 bg-gray-50 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8] font-mono" />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">EMI (₹/month) *</label>
                                <input value={form.emi} onChange={e => updateField('emi', e.target.value.replace(/\D/g, ''))}
                                    placeholder="Auto-calculated" className="w-full h-11 px-4 bg-gray-50 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8] font-mono" />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Processing Fee (₹)</label>
                                <input value={form.processing_fee} onChange={e => updateField('processing_fee', e.target.value.replace(/\D/g, ''))}
                                    placeholder="Optional" className="w-full h-11 px-4 bg-gray-50 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8] font-mono" />
                            </div>
                            <div className="col-span-2">
                                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider block mb-1.5">Notes</label>
                                <input value={form.notes} onChange={e => updateField('notes', e.target.value)}
                                    placeholder="Any conditions, requirements, or notes for the dealer" className="w-full h-11 px-4 bg-gray-50 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]" />
                            </div>
                        </div>
                        <div className="flex gap-3 mt-6">
                            <button onClick={() => setShowForm(false)} className="px-6 py-2.5 border-2 border-gray-200 rounded-xl text-sm font-bold text-gray-600 hover:bg-gray-50">Cancel</button>
                            <button onClick={handleAddOffer} disabled={submittingOffer}
                                className="px-8 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] disabled:opacity-50 flex items-center gap-2">
                                {submittingOffer ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add Offer
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* BOTTOM BAR */}
            {smStatus !== 'options_ready' && smStatus !== 'option_booked' && (
                <div className="sticky bottom-0 left-0 right-0 bg-[#F8F9FB] pt-4 pb-8 z-50">
                    <div className="max-w-[900px] mx-auto px-6">
                        <div className="flex justify-between items-center bg-white border border-gray-100 rounded-[20px] px-8 py-5 shadow-[0_-8px_30px_rgb(0,0,0,0.04)]">
                            <p className="text-sm text-gray-500">{offers.length} offer{offers.length !== 1 ? 's' : ''} added</p>
                            <button onClick={handleShareWithDealer} disabled={submittingOptions || offers.length === 0}
                                className="px-10 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] disabled:opacity-50 flex items-center gap-2">
                                {submittingOptions ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
                                Share Options with Dealer
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
