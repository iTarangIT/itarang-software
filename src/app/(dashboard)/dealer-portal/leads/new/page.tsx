'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, X, AlertCircle, Scan, Info, ChevronRight, ChevronDown, Loader2, ShieldCheck, UserPlus, ArrowRight } from 'lucide-react';
import { useAuth } from '@/components/auth/AuthProvider';
import { DatePicker } from '@/components/ui/date-picker';
import {
    SectionCard, InputField, SelectField, TextAreaField,
    ProgressHeader, StickyBottomBar, ErrorBanner,
    PrimaryButton, OutlineButton, OCRModal, FullPageLoader,
} from '@/components/dealer-portal/lead-wizard/shared';
import {
    INTEREST_LEVELS, PAYMENT_METHODS, VEHICLE_OWNERSHIP_OPTIONS,
    VEHICLE_CATEGORIES, isFinanceMethod,
} from '@/components/dealer-portal/lead-wizard/constants';

const emptyFormData = {
    full_name: '',
    phone: '',
    father_or_husband_name: '',
    dob: '',
    current_address: '',
    permanent_address: '',
    is_current_same: false,
    product_category_id: '',
    product_type_id: '',
    primary_product_id: '',
    interested_in: [] as string[],
    vehicle_rc: '',
    vehicle_ownership: '',
    vehicle_owner_name: '',
    vehicle_owner_phone: '',
    interest_level: 'hot',
    payment_method: 'other_finance',
    asset_model: '',
    asset_model_label: '',
    is_vehicle_category: false,
};

function NewLeadWizardContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const fromScraped = searchParams.get('from_scraped');
    const prefillName = searchParams.get('name');
    const prefillPhone = searchParams.get('phone');
    const { user } = useAuth();

    const [leadId, setLeadId] = useState<string | null>(null);
    const [referenceId, setReferenceId] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [initLoading, setInitLoading] = useState(true);
    const [lastSaved, setLastSaved] = useState<string | null>(null);
    const [isModified, setIsModified] = useState(false);

    const [formData, setFormData] = useState<any>(emptyFormData);
    const [additionalProducts, setAdditionalProducts] = useState<{ category_id: string; product_id: string; category_name: string }[]>([]);
    const [outOfStockProducts, setOutOfStockProducts] = useState<string[]>([]);

    const [errors, setErrors] = useState<Record<string, string>>({});
    const [apiError, setApiError] = useState<string | null>(null);
    const [duplicateMatch, setDuplicateMatch] = useState<any>(null);
    const [categories, setCategories] = useState<any[]>([]);
    const [products, setProducts] = useState<any[]>([]);
    const [showOCR, setShowOCR] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);
    const [showDraftPrompt, setShowDraftPrompt] = useState(false);
    const [hasDraft, setHasDraft] = useState(false);

    // ─── Draft Init ─────────────────────────────────────────────────────────

    const initDraft = async (fresh = false) => {
        setInitLoading(true);
        setApiError(null);
        try {
            const res = await fetch('/api/leads/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ initializeDraft: true, fresh })
            });
            const result = await res.json();
            if (result.success) {
                setLeadId(result.data.leadId);
                setReferenceId(result.data.referenceId);
                if (result.data.formData && !fresh) {
                    const fd = result.data.formData;
                    const hasData = fd.full_name || fd.phone || fd.dob || fd.father_or_husband_name;
                    if (hasData && result.data.resumed) {
                        setHasDraft(true);
                        setShowDraftPrompt(true);
                        setFormData((prev: any) => ({ ...prev, ...fd }));
                        setLastSaved('Draft resumed');
                    } else {
                        setFormData((prev: any) => ({ ...prev, ...fd }));
                    }
                }
            } else {
                setApiError(result.error?.message || 'Initialization failed. Please retry.');
            }
        } catch {
            setApiError('Connection lost. Please try again.');
        } finally {
            setInitLoading(false);
        }
    };

    const handleStartFresh = async () => {
        setShowDraftPrompt(false);
        setFormData(emptyFormData);
        setLeadId(null);
        setReferenceId(null);
        setIsModified(false);
        setAdditionalProducts([]);
        await initDraft(true);
    };

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const fresh = params.get('fresh') === 'true';
        initDraft(fresh);
    }, []);

    useEffect(() => {
        if (prefillName || prefillPhone) {
            setFormData((prev: any) => ({
                ...prev,
                full_name: prefillName || prev.full_name,
                phone: prefillPhone || prev.phone,
            }));
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Categories & Products ──────────────────────────────────────────────

    useEffect(() => {
        fetch('/api/inventory/categories')
            .then(r => r.json())
            .then(d => {
                console.log('[LeadWizard] categories response:', d);
                if (d.success) setCategories(d.data);
                else console.error('[LeadWizard] categories fetch failed:', d.error);
            })
            .catch(err => console.error('[LeadWizard] categories fetch error:', err));
    }, []);

    useEffect(() => {
        if (formData.asset_model) {
            fetch(`/api/inventory/products?category=${encodeURIComponent(formData.asset_model)}`)
                .then(r => r.json())
                .then(d => {
                    if (d.success) {
                        setProducts(d.data);
                        setOutOfStockProducts(d.data.filter((p: any) => p.available_quantity === 0).map((p: any) => p.id));
                    }
                });
        } else {
            setProducts([]);
            setOutOfStockProducts([]);
        }
    }, [formData.asset_model]);

    // ─── Field Handlers ─────────────────────────────────────────────────────

    const updateField = (field: string, value: any) => {
        let fin = value;
        if (['full_name', 'father_or_husband_name', 'vehicle_owner_name'].includes(field)) {
            fin = value.split(' ').map((s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '')).join(' ');
        }
        if (field === 'vehicle_rc') fin = value.toUpperCase();

        setFormData((prev: any) => {
            const next = { ...prev, [field]: fin };
            if (field === 'is_current_same' && fin) next.permanent_address = next.current_address;
            if (field === 'current_address' && next.is_current_same) next.permanent_address = fin;
            return next;
        });
        setIsModified(true);
        if (errors[field]) setErrors(prev => { const n = { ...prev }; delete n[field]; return n; });
    };

    const handlePhoneBlur = async () => {
        if (!formData.phone || formData.phone.length < 10) return;
        try {
            const res = await fetch(`/api/leads/check-duplicate?phone=${encodeURIComponent(formData.phone)}`);
            const data = await res.json();
            setDuplicateMatch(data.success && data.data.length > 0 ? data.data[0] : null);
        } catch { /* ignore */ }
    };

    const handleOCRResult = (data: any) => {
        if (data.full_name) updateField('full_name', data.full_name);
        if (data.father_or_husband_name) updateField('father_or_husband_name', data.father_or_husband_name);
        if (data.phone) updateField('phone', data.phone);
        if (data.dob) updateField('dob', data.dob);
        if (data.current_address) updateField('current_address', data.current_address);
        if (data.permanent_address) updateField('permanent_address', data.permanent_address);
    };

    // ─── Validation ─────────────────────────────────────────────────────────

    const calculateAge = (dob: string) => {
        if (!dob) return 0;
        const birthDate = new Date(dob);
        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        const m = today.getMonth() - birthDate.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
        return age;
    };

    const validate = () => {
        const e: Record<string, string> = {};
        const finFlow = isFinanceMethod(formData.payment_method);

        if (!formData.full_name || formData.full_name.trim().length < 2) e.full_name = 'Minimum 2 characters required';
        if (finFlow && !formData.father_or_husband_name?.trim()) e.father_or_husband_name = 'Required for finance cases';
        if (!formData.phone || formData.phone.replace(/\D/g, '').length < 10) e.phone = 'Invalid phone number';
        if (!formData.dob) e.dob = 'Required';
        else if (calculateAge(formData.dob) < 18) e.dob = 'Must be 18+';
        if (!formData.product_category_id) e.product_category_id = 'Required';
        if (!formData.primary_product_id) e.primary_product_id = 'Required';
        if (!formData.current_address || formData.current_address.trim().length < 20) e.current_address = 'Minimum 20 characters required';
        if (formData.permanent_address && formData.permanent_address.trim().length < 20) e.permanent_address = 'Minimum 20 characters required';

        const isVehicle = formData.is_vehicle_category;
        if (isVehicle && formData.vehicle_rc?.trim()) {
            if (!formData.vehicle_ownership) e.vehicle_ownership = 'Required';
            if (!formData.vehicle_owner_name?.trim()) e.vehicle_owner_name = 'Required';
            if (!formData.vehicle_owner_phone?.trim()) e.vehicle_owner_phone = 'Required';
        }

        setErrors(e);
        return Object.keys(e).length === 0;
    };

    // ─── Submit ─────────────────────────────────────────────────────────────

    const commitStep = () => {
        if (!leadId) { setApiError('Lead draft not initialized. Please refresh.'); return; }
        if (!validate()) return;
        setShowConfirm(true);
    };

    const handleFinalConfirm = async () => {
        setShowConfirm(false);
        setLoading(true);
        const leadScoreMap: Record<string, number> = { hot: 90, warm: 60, cold: 30 };

        try {
            const res = await fetch('/api/leads/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...formData,
                    leadId,
                    commitStep: true,
                    lead_score: leadScoreMap[formData.interest_level] || 30,
                    additional_products: additionalProducts,
                })
            });
            const result = await res.json();

            if (result.success) {
                const { leadId: updatedLeadId } = result.data;
                if (fromScraped && updatedLeadId) {
                    fetch(`/api/scraper/leads/${fromScraped}/convert`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ converted_lead_id: updatedLeadId }),
                    }).catch(console.error);
                }

                if (formData.payment_method === 'cash' || formData.payment_method === 'upfront') {
                    router.push('/dealer-portal/leads');
                } else if (formData.interest_level === 'hot' && isFinanceMethod(formData.payment_method)) {
                    router.push(`/dealer-portal/leads/${updatedLeadId}/kyc`);
                } else {
                    router.push('/dealer-portal/leads');
                }
            } else {
                const details = result.error?.details?.map((d: any) => `${d.path}: ${d.message}`).join(', ');
                setApiError(details ? `Validation error — ${details}` : (result.error?.message || 'Server Error'));
            }
        } catch {
            setApiError('Connection failed. Please retry.');
        } finally {
            setLoading(false);
        }
    };

    const handleCancel = async () => {
        if (!isModified) { router.push('/dealer-portal'); return; }
        if (confirm('Discard draft?')) {
            if (leadId) await fetch(`/api/leads/draft/${leadId}`, { method: 'DELETE' }).catch(() => {});
            router.push('/dealer-portal');
        }
    };

    // ─── Loading States ─────────────────────────────────────────────────────

    if (initLoading) return <FullPageLoader />;

    if (!leadId && apiError) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB]">
                <div className="text-center space-y-4">
                    <AlertCircle className="w-12 h-12 text-red-500 mx-auto" />
                    <p className="text-red-600 font-medium">{apiError}</p>
                    <button onClick={() => initDraft()} className="px-6 py-2 bg-[#1D4ED8] text-white rounded-lg hover:bg-[#1E40AF]">Retry</button>
                </div>
            </div>
        );
    }

    const isVehicleCategory = formData.is_vehicle_category;
    const finFlow = isFinanceMethod(formData.payment_method);

    return (
        <div className="min-h-screen bg-[#F8F9FB]">
            {/* Draft Resume Modal */}
            {showDraftPrompt && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 p-6 space-y-4">
                        <h3 className="text-lg font-bold text-gray-900">Resume Previous Draft?</h3>
                        <p className="text-sm text-gray-600">You have an unsaved lead draft. Would you like to continue where you left off?</p>
                        <div className="flex gap-3">
                            <button onClick={handleStartFresh} className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl font-medium text-gray-700 hover:bg-gray-50">Start Fresh</button>
                            <button onClick={() => setShowDraftPrompt(false)} className="flex-1 px-4 py-2.5 bg-[#1D4ED8] text-white rounded-xl font-medium hover:bg-[#1E40AF]">Resume Draft</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Confirmation Modal */}
            {showConfirm && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">
                        {/* Header gradient */}
                        <div className="bg-gradient-to-r from-[#0047AB] to-[#1D4ED8] px-6 py-5">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                                    <UserPlus className="w-5 h-5 text-white" />
                                </div>
                                <div>
                                    <h3 className="text-lg font-bold text-white">Confirm Lead Creation</h3>
                                    <p className="text-blue-100 text-xs mt-0.5">Reference: {referenceId || 'Generating...'}</p>
                                </div>
                            </div>
                        </div>

                        {/* Body */}
                        <div className="px-6 py-5 space-y-4">
                            {/* Summary card */}
                            <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 space-y-2.5">
                                {formData.full_name && (
                                    <div className="flex justify-between items-center">
                                        <span className="text-xs text-gray-500 font-medium">Customer</span>
                                        <span className="text-sm font-semibold text-gray-900">{formData.full_name}</span>
                                    </div>
                                )}
                                {formData.phone && (
                                    <div className="flex justify-between items-center">
                                        <span className="text-xs text-gray-500 font-medium">Phone</span>
                                        <span className="text-sm font-semibold text-gray-900">{formData.phone}</span>
                                    </div>
                                )}
                                {formData.asset_model && (
                                    <div className="flex justify-between items-center">
                                        <span className="text-xs text-gray-500 font-medium">Product</span>
                                        <span className="text-sm font-semibold text-gray-900">{formData.product_name || formData.asset_model}</span>
                                    </div>
                                )}
                                {formData.payment_method && (
                                    <div className="flex justify-between items-center">
                                        <span className="text-xs text-gray-500 font-medium">Payment</span>
                                        <span className="text-sm font-semibold text-gray-900 capitalize">{formData.payment_method?.replace(/_/g, ' ')}</span>
                                    </div>
                                )}
                            </div>

                            {/* Next step info */}
                            <div className={`flex items-start gap-3 p-3 rounded-xl border ${
                                formData.interest_level === 'hot' && finFlow
                                    ? 'bg-emerald-50 border-emerald-200'
                                    : 'bg-blue-50 border-blue-200'
                            }`}>
                                <ShieldCheck className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
                                    formData.interest_level === 'hot' && finFlow ? 'text-emerald-600' : 'text-blue-600'
                                }`} />
                                <p className={`text-xs leading-relaxed ${
                                    formData.interest_level === 'hot' && finFlow ? 'text-emerald-700' : 'text-blue-700'
                                }`}>
                                    {formData.interest_level === 'hot' && finFlow
                                        ? 'This lead will be created and you will proceed directly to KYC verification (Step 2).'
                                        : 'This lead will be created and saved. You can initiate KYC later from the leads list.'}
                                </p>
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="px-6 pb-5 flex gap-3">
                            <button
                                onClick={() => setShowConfirm(false)}
                                className="flex-1 px-4 py-3 border-2 border-gray-200 rounded-xl font-semibold text-sm text-gray-600 hover:bg-gray-50 hover:border-gray-300 transition-all"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleFinalConfirm}
                                disabled={loading}
                                className="flex-1 px-4 py-3 bg-gradient-to-r from-[#0047AB] to-[#1D4ED8] text-white rounded-xl font-semibold text-sm hover:from-[#003580] hover:to-[#1E40AF] transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-blue-500/25"
                            >
                                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                                {loading ? 'Creating...' : 'Create Lead'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Help Modal */}
            {showHelp && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full mx-4 p-6 space-y-4">
                        <div className="flex justify-between items-start">
                            <h3 className="text-lg font-bold text-gray-900">Help — Step 1</h3>
                            <button onClick={() => setShowHelp(false)} className="p-1 hover:bg-gray-100 rounded-lg"><X className="w-5 h-5" /></button>
                        </div>
                        <div className="text-sm text-gray-600 space-y-3">
                            <p><strong>Required fields</strong> are marked with a red asterisk (*). Father/Husband Name becomes required for finance cases.</p>
                            <p><strong>Phone</strong> must be a valid 10-digit Indian mobile number. Duplicates are flagged but allowed.</p>
                            <p><strong>Product Category</strong> determines available products and whether vehicle details are shown.</p>
                            <p><strong>Hot leads</strong> with finance will proceed directly to KYC. Warm/Cold leads are saved for later follow-up.</p>
                        </div>
                    </div>
                </div>
            )}

            {/* OCR Modal */}
            <OCRModal open={showOCR} onClose={() => setShowOCR(false)} onResult={handleOCRResult} />

            <div className="max-w-[1200px] mx-auto px-6 py-8 pb-40">
                {/* Header */}
                <ProgressHeader
                    title="Create New Lead"
                    subtitle={`Reference ID: ${referenceId || '#IT-XXXX-XXXXXXX'}`}
                    step={1}
                    onBack={() => router.back()}
                    rightAction={
                        <div className="flex items-center gap-3">
                            <button onClick={() => setShowHelp(true)} className="p-2 text-gray-400 hover:text-gray-600">
                                <Info className="w-5 h-5" />
                            </button>
                            <button
                                onClick={() => setShowOCR(true)}
                                className="flex items-center gap-2 px-5 py-2.5 bg-white border border-gray-200 rounded-xl font-bold text-sm text-gray-800 shadow-sm hover:border-[#1D4ED8] hover:text-[#1D4ED8] transition-all"
                            >
                                <Scan className="w-4 h-4" /> Auto-fill from ID
                            </button>
                        </div>
                    }
                />

                {/* Error & Duplicate Banners */}
                <ErrorBanner message={apiError} onDismiss={() => setApiError(null)} />

                {duplicateMatch && (
                    <div className="mb-6 bg-amber-50 border border-amber-200 p-4 rounded-xl flex items-start justify-between gap-4">
                        <div>
                            <p className="text-sm font-semibold text-amber-800">A lead with this phone number already exists</p>
                            <p className="text-xs text-amber-700 mt-1">
                                Existing lead: {duplicateMatch.owner_name || duplicateMatch.full_name || 'Unknown'} ({duplicateMatch.id || 'N/A'})
                            </p>
                        </div>
                        <button onClick={() => router.push(`/dealer-portal/leads?new=${duplicateMatch.id}`)} className="px-3 py-2 rounded-lg bg-white border border-amber-300 text-xs font-bold text-amber-700 hover:bg-amber-100">
                            View Existing Lead
                        </button>
                    </div>
                )}

                <main className="grid grid-cols-1 gap-6">
                    {/* ─── Personal Information ──────────────────────────── */}
                    <SectionCard title="Personal Information">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6">
                            <InputField label="Full Name" value={formData.full_name} onChange={v => updateField('full_name', v)} error={errors.full_name} placeholder="Vijay Sharma" required />
                            <InputField label={`Father/Husband Name${finFlow ? '' : ''}`} value={formData.father_or_husband_name} onChange={v => updateField('father_or_husband_name', v)} error={errors.father_or_husband_name} placeholder="Richard Doe" required={finFlow} />

                            <div className="space-y-2">
                                <label className="text-sm font-bold text-gray-900 px-1">Date of Birth <span className="text-red-500">*</span></label>
                                <DatePicker value={formData.dob ?? ''} onChange={(v: string) => updateField('dob', v)} minAge={18} error={!!errors.dob} />
                                {errors.dob && <p className="text-[10px] text-red-500 font-bold px-1">{errors.dob}</p>}
                            </div>

                            <InputField label="Phone Number" value={formData.phone} onChange={v => updateField('phone', v)} onBlur={handlePhoneBlur} error={errors.phone} placeholder="9876543210" required />

                            <div className="md:col-span-2">
                                <TextAreaField label="Current Address" value={formData.current_address} onChange={v => updateField('current_address', v)} error={errors.current_address} placeholder="123, Main Street, City, State - 123456" required />
                            </div>

                            <div className="md:col-span-2 space-y-2">
                                <div className="flex items-center justify-between px-1">
                                    <label className="text-sm font-bold text-gray-900">Permanent Address</label>
                                    <label className="flex items-center gap-2 cursor-pointer group">
                                        <input
                                            type="checkbox"
                                            checked={formData.is_current_same}
                                            onChange={e => updateField('is_current_same', e.target.checked)}
                                            className="w-4 h-4 rounded border-gray-300 text-[#0047AB] focus:ring-[#0047AB]"
                                        />
                                        <span className="text-xs font-medium text-gray-600">Same as current address</span>
                                    </label>
                                </div>
                                <textarea
                                    value={formData.permanent_address ?? ''}
                                    disabled={formData.is_current_same}
                                    onChange={e => updateField('permanent_address', e.target.value)}
                                    placeholder="123, Main Street, City, State - 123456"
                                    rows={2}
                                    className={`w-full px-4 py-3 bg-white border-2 rounded-xl outline-none transition-all text-sm placeholder-gray-400 resize-none ${
                                        formData.is_current_same ? 'bg-gray-50 border-[#F5F5F5] text-gray-400' :
                                        errors.permanent_address ? 'border-red-400' :
                                        'border-[#EBEBEB] focus:border-[#1D4ED8] focus:ring-4 focus:ring-blue-50/50'
                                    }`}
                                />
                                {errors.permanent_address && <p className="text-[10px] text-red-500 font-bold px-1">{errors.permanent_address}</p>}
                            </div>
                        </div>
                    </SectionCard>

                    {/* ─── Product Details + Vehicle Details (side by side) ─ */}
                    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
                        {/* Product Details */}
                        <div className="lg:col-span-2">
                            <SectionCard title="Product Details">
                                <div className="space-y-6">
                                    <div className="space-y-2">
                                        <label className="text-sm font-bold text-gray-900 px-1">Product Category <span className="text-red-500">*</span></label>
                                        <div className="relative">
                                            <select
                                                value={formData.asset_model ?? ''}
                                                onChange={e => {
                                                    const cat = categories.find((c: any) => c.slug === e.target.value);
                                                    setFormData((p: any) => ({
                                                        ...p,
                                                        asset_model: cat?.slug || e.target.value,
                                                        asset_model_label: cat?.name || e.target.value,
                                                        is_vehicle_category: cat?.isVehicleCategory || false,
                                                        product_category_id: cat?.id || '',
                                                        primary_product_id: '',
                                                    }));
                                                    setIsModified(true);
                                                }}
                                                className={`w-full h-11 px-4 pr-10 bg-white border-2 rounded-xl outline-none appearance-none text-sm transition-all ${
                                                    errors.product_category_id ? 'border-red-400' : 'border-[#EBEBEB] focus:border-[#1D4ED8]'
                                                } ${!formData.asset_model ? 'text-gray-400' : 'text-gray-900'}`}
                                            >
                                                <option value="">Select from Current Inventory</option>
                                                {categories.map((c: any) => <option key={c.id} value={c.slug}>{c.name}</option>)}
                                            </select>
                                            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                                        </div>
                                        {errors.product_category_id && <p className="text-[10px] text-red-500 font-bold px-1">{errors.product_category_id}</p>}
                                    </div>

                                    <div className="space-y-2">
                                        <label className="text-sm font-bold text-gray-900 px-1">Product Type</label>
                                        <div className="relative">
                                            <select
                                                value={formData.primary_product_id ?? ''}
                                                onChange={e => updateField('primary_product_id', e.target.value)}
                                                className={`w-full h-11 px-4 pr-10 bg-white border-2 rounded-xl outline-none appearance-none text-sm transition-all ${
                                                    errors.primary_product_id ? 'border-red-400' : 'border-[#EBEBEB] focus:border-[#1D4ED8]'
                                                } ${!formData.primary_product_id ? 'text-gray-400' : 'text-gray-900'}`}
                                            >
                                                <option value="">Select Product type</option>
                                                {products.map((p: any) => (
                                                    <option key={p.id} value={p.id}>
                                                        {p.name} — {p.voltage_v}V / {p.capacity_ah}Ah | SKU: {p.sku}{p.warranty_months ? ` | ${p.warranty_months}mo warranty` : ''}{outOfStockProducts.includes(p.id) ? ' (Out of Stock)' : ''}
                                                    </option>
                                                ))}
                                            </select>
                                            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                                        </div>
                                        {outOfStockProducts.includes(formData.primary_product_id) && (
                                            <div className="flex items-center justify-between gap-3 px-3 py-3 bg-amber-50 border border-amber-200 rounded-lg mt-2">
                                                <div className="flex items-center gap-2">
                                                    <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                                                    <span className="text-xs font-medium text-amber-700">Product out of stock</span>
                                                </div>
                                                <button onClick={() => router.push('/dealer-portal/oem-orders/new')} className="px-3 py-1 text-xs font-bold bg-amber-600 text-white rounded-lg hover:bg-amber-700">Order from OEM</button>
                                            </div>
                                        )}
                                        {errors.primary_product_id && <p className="text-[10px] text-red-500 font-bold px-1">{errors.primary_product_id}</p>}
                                    </div>

                                    {/* Additional products */}
                                    {additionalProducts.map((ap, idx) => (
                                        <div key={idx} className="flex items-end gap-3 bg-gray-50 p-4 rounded-xl border border-gray-100">
                                            <div className="flex-1">
                                                <label className="text-xs font-bold text-gray-600 px-1 mb-1 block">Additional Product {idx + 1}</label>
                                                <select
                                                    value={ap.product_id}
                                                    onChange={e => {
                                                        const updated = [...additionalProducts];
                                                        updated[idx].product_id = e.target.value;
                                                        setAdditionalProducts(updated);
                                                        setIsModified(true);
                                                    }}
                                                    className="w-full h-10 px-4 bg-white border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]"
                                                >
                                                    <option value="">Select product</option>
                                                    {products.map((p: any) => <option key={p.id} value={p.id}>{p.name} — {p.voltage_v}V / {p.capacity_ah}Ah | SKU: {p.sku}</option>)}
                                                </select>
                                            </div>
                                            <button onClick={() => { setAdditionalProducts(prev => prev.filter((_, i) => i !== idx)); setIsModified(true); }} className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg">
                                                <X className="w-4 h-4" />
                                            </button>
                                        </div>
                                    ))}

                                    <button
                                        onClick={() => {
                                            setAdditionalProducts(prev => [...prev, { category_id: formData.product_category_id, product_id: '', category_name: formData.asset_model }]);
                                            setIsModified(true);
                                        }}
                                        className="flex items-center gap-2 text-sm font-bold text-[#0047AB] hover:text-[#003580] transition-colors px-1"
                                    >
                                        <Plus className="w-4 h-4" /> Add Another Product
                                    </button>
                                </div>
                            </SectionCard>
                        </div>

                        {/* Vehicle Details */}
                        <div className="lg:col-span-3">
                            <SectionCard title={isVehicleCategory ? 'Vehicle Details' : 'Vehicle Details'}>
                                {!isVehicleCategory && (
                                    <p className="text-sm text-gray-400 font-medium px-1 mb-4">Vehicle details are only applicable for 2W/3W/4W categories.</p>
                                )}
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-6">
                                    <InputField label="Vehicle Reg. Number" value={formData.vehicle_rc} onChange={v => updateField('vehicle_rc', v)} placeholder="HR 35 A 78989" />
                                    <SelectField
                                        label={`Vehicle Ownership${formData.vehicle_rc?.trim() ? ' *' : ''}`}
                                        value={formData.vehicle_ownership}
                                        onChange={v => updateField('vehicle_ownership', v)}
                                        options={VEHICLE_OWNERSHIP_OPTIONS.map(o => ({ value: o.label, label: o.label }))}
                                        placeholder="Select ownership"
                                        error={errors.vehicle_ownership}
                                    />
                                    <InputField label={`Owner Full Name${formData.vehicle_rc?.trim() ? ' *' : ''}`} value={formData.vehicle_owner_name} onChange={v => updateField('vehicle_owner_name', v)} placeholder="Vijay Sharma" error={errors.vehicle_owner_name} />
                                    <InputField label={`Owner Phone${formData.vehicle_rc?.trim() ? ' *' : ''}`} value={formData.vehicle_owner_phone} onChange={v => updateField('vehicle_owner_phone', v)} placeholder="+91 9876543210" error={errors.vehicle_owner_phone} />
                                </div>
                                {formData.vehicle_rc?.trim() && (
                                    <div className="mt-4 px-3 py-2 bg-blue-50 border border-blue-100 rounded-lg">
                                        <p className="text-xs font-medium text-blue-700">You&apos;ve entered vehicle details. Ownership, Owner Name, and Owner Phone are now required.</p>
                                    </div>
                                )}
                            </SectionCard>
                        </div>
                    </div>

                    {/* ─── Lead Classification ───────────────────────────── */}
                    <SectionCard title="Lead Classification">
                        <div className="space-y-6">
                            <div>
                                <label className="text-sm font-bold text-gray-900 px-1 mb-3 block">Lead Interest Level</label>
                                <div className="flex bg-[#F1F3F5] rounded-[14px] p-1.5">
                                    {INTEREST_LEVELS.map(lvl => (
                                        <button
                                            key={lvl.value}
                                            onClick={() => updateField('interest_level', lvl.value)}
                                            className={`flex-1 py-3 text-sm font-bold rounded-[10px] transition-all capitalize tracking-tight ${
                                                formData.interest_level === lvl.value
                                                    ? 'bg-[#0047AB] text-white shadow-sm'
                                                    : 'text-gray-500 hover:text-gray-800'
                                            }`}
                                        >
                                            {lvl.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </SectionCard>

                    {/* ─── Select Payment Method ─────────────────────────── */}
                    <SectionCard title="Select Payment Method">
                        <div className="space-y-4">
                            <div className="relative">
                                <select
                                    value={formData.payment_method}
                                    onChange={e => updateField('payment_method', e.target.value)}
                                    className="w-full h-11 px-4 pr-10 bg-white border-2 border-[#EBEBEB] rounded-xl outline-none appearance-none text-sm font-medium text-gray-900 focus:border-[#1D4ED8] transition-all"
                                >
                                    {PAYMENT_METHODS.map(pm => (
                                        <option key={pm.value} value={pm.value}>{pm.label}</option>
                                    ))}
                                </select>
                                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                            </div>

                            <div className="flex items-center gap-6 px-1">
                                {PAYMENT_METHODS.map(pm => (
                                    <label key={pm.value} className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="radio"
                                            name="payment_method"
                                            checked={formData.payment_method === pm.value}
                                            onChange={() => updateField('payment_method', pm.value)}
                                            className="w-4 h-4 text-[#0047AB] border-gray-300 focus:ring-[#0047AB]"
                                        />
                                        <span className="text-sm font-medium text-gray-700">{pm.label}</span>
                                    </label>
                                ))}
                            </div>

                            {isFinanceMethod(formData.payment_method) && (
                                <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl">
                                    <p className="text-xs font-medium text-amber-700">
                                        Finance case selected. KYC documents will be mandatory in the next step.
                                    </p>
                                </div>
                            )}

                            <div className="px-4 py-3 bg-gray-50 rounded-xl border border-gray-100">
                                {formData.payment_method === 'cash' ? (
                                    <p className="text-xs font-medium text-gray-600">
                                        <span className="inline-block w-2 h-2 bg-green-500 rounded-full mr-2" />
                                        <strong>Cash Payment:</strong> KYC verification will be skipped. Lead goes directly to product selection.
                                    </p>
                                ) : formData.interest_level === 'hot' ? (
                                    <p className="text-xs font-medium text-gray-600">
                                        <span className="inline-block w-2 h-2 bg-red-500 rounded-full mr-2" />
                                        <strong>Hot Lead:</strong> After creating, you will proceed directly to KYC (Step 2).
                                    </p>
                                ) : (
                                    <p className="text-xs font-medium text-gray-600">
                                        <span className={`inline-block w-2 h-2 ${formData.interest_level === 'warm' ? 'bg-amber-500' : 'bg-blue-400'} rounded-full mr-2`} />
                                        <strong>{formData.interest_level === 'warm' ? 'Warm' : 'Cold'} Lead:</strong> After creating, the lead will be saved and you will return to the leads list.
                                    </p>
                                )}
                            </div>
                        </div>
                    </SectionCard>
                </main>

                {/* ─── Bottom Bar ────────────────────────────────────────── */}
                {!showConfirm && (
                    <StickyBottomBar lastSaved={lastSaved}>
                        <OutlineButton onClick={handleCancel}>Cancel</OutlineButton>
                        <PrimaryButton onClick={commitStep} loading={loading}>
                            <ChevronRight className="w-4 h-4" /> Create Lead
                        </PrimaryButton>
                    </StickyBottomBar>
                )}
            </div>
        </div>
    );
}

export default function NewLeadPage() {
    return (
        <Suspense fallback={<FullPageLoader />}>
            <NewLeadWizardContent />
        </Suspense>
    );
}
