'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Megaphone, Send, Users, MessageSquareText, Loader2, Sparkles, Plus, Trash2, Filter } from 'lucide-react';

type Segment = {
    id: string;
    name: string;
    description: string;
    category: 'prebuilt' | 'custom';
};

type CustomRule = {
    id: string;
    field: string;
    operator: string;
    value: string;
};

const PREBUILT_SEGMENTS: Segment[] = [
    { id: 'all_customers', name: 'All Customers', description: 'Send to all customers/leads in your database.', category: 'prebuilt' },
    { id: 'hot_leads', name: 'Hot Leads', description: 'Only leads marked as HOT (high intent).', category: 'prebuilt' },
    { id: 'warm_leads', name: 'Warm Leads', description: 'Leads marked as WARM (medium intent).', category: 'prebuilt' },
    { id: 'pending_loans', name: 'Pending Loans', description: 'Customers with loan applications in processing status.', category: 'prebuilt' },
    { id: 'overdue_payments', name: 'Overdue Payments', description: 'Customers with overdue loan payments.', category: 'prebuilt' },
    { id: 'inactive_customers', name: 'Inactive Customers', description: 'Leads not updated in 30 days or marked lost.', category: 'prebuilt' },
    { id: 'active_assets', name: 'Active Asset Owners', description: 'Customers with active deployed assets.', category: 'prebuilt' },
    { id: 'maintenance_due', name: 'Maintenance Due', description: 'Customers whose assets are due for maintenance.', category: 'prebuilt' },
    { id: 'warranty_expiring', name: 'Warranty Expiring', description: 'Customers with assets whose warranty expires within 30 days.', category: 'prebuilt' },
    { id: 'low_battery', name: 'Low Battery Health', description: 'Customers with deployed assets that have battery health below 30%.', category: 'prebuilt' },
];

const CUSTOM_FIELDS = [
    { id: 'interest_level', label: 'Lead Interest Level', operators: ['equals', 'not_equals'], values: ['hot', 'warm', 'cold'] },
    { id: 'loan_status', label: 'Loan Status', operators: ['equals', 'not_equals'], values: ['active', 'closed', 'defaulted', 'pending'] },
    { id: 'payment_status', label: 'Payment Status', operators: ['equals', 'not_equals'], values: ['paid', 'pending', 'overdue'] },
    { id: 'asset_category', label: 'Asset Category', operators: ['equals', 'not_equals'], values: ['2W', '3W', 'Inverter'] },
    { id: 'asset_status', label: 'Asset Status', operators: ['equals', 'not_equals'], values: ['active', 'maintenance', 'inactive', 'returned'] },
    { id: 'days_inactive', label: 'Days Since Last Activity', operators: ['greater_than', 'less_than'], values: [] },
    { id: 'overdue_days', label: 'Overdue Days', operators: ['greater_than', 'less_than', 'equals'], values: [] },
    { id: 'battery_health', label: 'Battery Health %', operators: ['greater_than', 'less_than'], values: [] },
    { id: 'created_within', label: 'Lead Created Within (days)', operators: ['less_than'], values: [] },
];

export default function NewCampaignPage() {
    const router = useRouter();
    const [name, setName] = useState('');
    const [type, setType] = useState<'sms' | 'whatsapp' | 'email'>('whatsapp');
    const [segmentMode, setSegmentMode] = useState<'prebuilt' | 'custom'>('prebuilt');
    const [segment, setSegment] = useState<string>('all_customers');
    const [customRules, setCustomRules] = useState<CustomRule[]>([{ id: '1', field: 'interest_level', operator: 'equals', value: 'hot' }]);
    const [customLogic, setCustomLogic] = useState<'and' | 'or'>('and');
    const [message, setMessage] = useState('');
    const [estimating, setEstimating] = useState(false);
    const [audienceCount, setAudienceCount] = useState<number | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const segmentMeta = useMemo(() => PREBUILT_SEGMENTS.find(s => s.id === segment), [segment]);

    const estimate = async () => {
        setEstimating(true);
        setError(null);
        try {
            const payload = segmentMode === 'prebuilt'
                ? { segment }
                : { custom_rules: customRules, logic: customLogic };
            const res = await fetch('/api/campaigns/estimate-audience', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (res.ok && data.success) setAudienceCount(data.data.count);
            else setAudienceCount(null);
        } catch {
            setAudienceCount(null);
            setError('Could not estimate audience.');
        } finally {
            setEstimating(false);
        }
    };

    useEffect(() => {
        estimate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [segment, segmentMode]);

    const addRule = () => {
        setCustomRules(prev => [...prev, { id: Date.now().toString(), field: 'interest_level', operator: 'equals', value: '' }]);
    };

    const removeRule = (id: string) => {
        setCustomRules(prev => prev.filter(r => r.id !== id));
    };

    const updateRule = (id: string, updates: Partial<CustomRule>) => {
        setCustomRules(prev => prev.map(r => r.id === id ? { ...r, ...updates } : r));
    };

    const createCampaign = async () => {
        setSaving(true);
        setError(null);
        try {
            const audienceFilter = segmentMode === 'prebuilt'
                ? { segment }
                : { custom_rules: customRules, logic: customLogic };
            const res = await fetch('/api/campaigns', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    name,
                    type,
                    message_content: message,
                    audience_filter: audienceFilter,
                    total_audience: audienceCount ?? undefined,
                }),
            });
            const data = await res.json();
            if (res.ok && data.success) {
                router.push('/dealer-portal');
            } else {
                setError(data?.error?.message || 'Failed to create campaign');
            }
        } catch {
            setError('Connection lost. Please try again.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                    <Link
                        href="/dealer-portal"
                        className="mt-1 inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 text-sm font-semibold"
                    >
                        <ArrowLeft className="w-4 h-4" />
                        Back
                    </Link>
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900">Start Campaign</h1>
                        <p className="text-gray-500 mt-1">Create an SMS/WhatsApp/Email campaign with pre-built or custom audience segments.</p>
                    </div>
                </div>
            </div>

            {error && (
                <div className="p-4 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 space-y-6">
                    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                        <div className="p-5 border-b border-gray-100 flex items-center gap-3">
                            <div className="p-2 rounded-xl bg-blue-50 text-blue-700">
                                <Megaphone className="w-5 h-5" />
                            </div>
                            <div>
                                <h2 className="font-bold text-gray-900">Campaign Details</h2>
                                <p className="text-sm text-gray-500">Define channel, audience segment and message.</p>
                            </div>
                        </div>
                        <div className="p-5 space-y-5">
                            <div>
                                <label className="text-sm font-semibold text-gray-700">Campaign Name</label>
                                <input
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="e.g., February EMI Reminder"
                                    className="mt-2 w-full px-4 py-3 rounded-xl border border-gray-200 bg-white focus:ring-2 focus:ring-brand-100 focus:border-brand-200 outline-none text-sm"
                                />
                            </div>

                            <div>
                                <label className="text-sm font-semibold text-gray-700">Channel</label>
                                <div className="mt-2 grid grid-cols-3 gap-2">
                                    {([
                                        { id: 'whatsapp', label: 'WhatsApp' },
                                        { id: 'sms', label: 'SMS' },
                                        { id: 'email', label: 'Email' },
                                    ] as const).map((c) => (
                                        <button
                                            key={c.id}
                                            type="button"
                                            onClick={() => setType(c.id)}
                                            className={`px-3 py-2 rounded-xl border text-sm font-semibold transition-colors ${type === c.id ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}
                                        >
                                            {c.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Segment Mode Toggle */}
                            <div>
                                <label className="text-sm font-semibold text-gray-700">Audience Targeting</label>
                                <div className="mt-2 flex gap-2">
                                    <button onClick={() => setSegmentMode('prebuilt')} className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${segmentMode === 'prebuilt' ? 'bg-[#0047AB] text-white' : 'bg-white border border-gray-200 text-gray-600'}`}>
                                        <Users className="w-4 h-4 inline mr-1.5" />Pre-built Segments
                                    </button>
                                    <button onClick={() => setSegmentMode('custom')} className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${segmentMode === 'custom' ? 'bg-[#0047AB] text-white' : 'bg-white border border-gray-200 text-gray-600'}`}>
                                        <Filter className="w-4 h-4 inline mr-1.5" />Custom Segment Builder
                                    </button>
                                </div>
                            </div>

                            {segmentMode === 'prebuilt' ? (
                                <div>
                                    <label className="text-sm font-semibold text-gray-700">Select Segment</label>
                                    <div className="mt-2 grid grid-cols-2 gap-2">
                                        {PREBUILT_SEGMENTS.map(s => (
                                            <button
                                                key={s.id}
                                                onClick={() => setSegment(s.id)}
                                                className={`text-left p-3 rounded-xl border text-sm transition-all ${segment === s.id ? 'border-[#0047AB] bg-blue-50 ring-1 ring-[#0047AB]' : 'border-gray-200 bg-white hover:border-gray-300'}`}
                                            >
                                                <div className="font-semibold text-gray-900">{s.name}</div>
                                                <div className="text-xs text-gray-500 mt-0.5">{s.description}</div>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ) : (
                                <div>
                                    <div className="flex items-center justify-between mb-3">
                                        <label className="text-sm font-semibold text-gray-700">Custom Rules</label>
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs text-gray-500">Match:</span>
                                            <button onClick={() => setCustomLogic('and')} className={`px-3 py-1 rounded-lg text-xs font-bold ${customLogic === 'and' ? 'bg-[#0047AB] text-white' : 'bg-gray-100 text-gray-600'}`}>AND</button>
                                            <button onClick={() => setCustomLogic('or')} className={`px-3 py-1 rounded-lg text-xs font-bold ${customLogic === 'or' ? 'bg-[#0047AB] text-white' : 'bg-gray-100 text-gray-600'}`}>OR</button>
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        {customRules.map((rule, idx) => {
                                            const fieldDef = CUSTOM_FIELDS.find(f => f.id === rule.field);
                                            return (
                                                <div key={rule.id} className="flex items-center gap-2 p-3 bg-gray-50 rounded-xl border border-gray-100">
                                                    {idx > 0 && <span className="text-[10px] font-bold text-gray-400 uppercase w-8">{customLogic}</span>}
                                                    {idx === 0 && <span className="text-[10px] font-bold text-gray-400 uppercase w-8">IF</span>}
                                                    <select value={rule.field} onChange={e => updateRule(rule.id, { field: e.target.value, value: '' })} className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs font-medium bg-white">
                                                        {CUSTOM_FIELDS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                                                    </select>
                                                    <select value={rule.operator} onChange={e => updateRule(rule.id, { operator: e.target.value })} className="px-3 py-2 border border-gray-200 rounded-lg text-xs font-medium bg-white">
                                                        {(fieldDef?.operators || ['equals']).map(op => (
                                                            <option key={op} value={op}>{op.replace(/_/g, ' ')}</option>
                                                        ))}
                                                    </select>
                                                    {fieldDef && fieldDef.values.length > 0 ? (
                                                        <select value={rule.value} onChange={e => updateRule(rule.id, { value: e.target.value })} className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs font-medium bg-white">
                                                            <option value="">Select...</option>
                                                            {fieldDef.values.map(v => <option key={v} value={v}>{v}</option>)}
                                                        </select>
                                                    ) : (
                                                        <input value={rule.value} onChange={e => updateRule(rule.id, { value: e.target.value })} placeholder="Value" className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs bg-white" />
                                                    )}
                                                    {customRules.length > 1 && (
                                                        <button onClick={() => removeRule(rule.id)} className="p-1.5 text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                    <button onClick={addRule} className="mt-2 inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-[#0047AB] hover:bg-blue-50 rounded-lg">
                                        <Plus className="w-3.5 h-3.5" /> Add Rule
                                    </button>
                                    <button onClick={estimate} className="mt-2 ml-3 inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg">
                                        <Users className="w-3.5 h-3.5" /> Estimate Audience
                                    </button>
                                </div>
                            )}

                            <div>
                                <label className="text-sm font-semibold text-gray-700">Message</label>
                                <textarea
                                    value={message}
                                    onChange={(e) => setMessage(e.target.value)}
                                    rows={5}
                                    placeholder="Write your message here. Use {name} for customer name, {amount} for due amount..."
                                    className="mt-2 w-full px-4 py-3 rounded-xl border border-gray-200 bg-white focus:ring-2 focus:ring-brand-100 focus:border-brand-200 outline-none text-sm"
                                />
                                <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                                    <span>{message.length} characters</span>
                                    <button
                                        type="button"
                                        onClick={() => setMessage((m) => m || 'Hello {name}, your next payment is due. Please contact us for assistance.')}
                                        className="inline-flex items-center gap-1.5 hover:text-brand-700"
                                    >
                                        <Sparkles className="w-3.5 h-3.5" />
                                        Suggest text
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <button
                        onClick={createCampaign}
                        disabled={saving || !name.trim() || !message.trim()}
                        className={`w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-2xl text-sm font-semibold ${saving || !name.trim() || !message.trim() ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-brand-600 hover:bg-brand-700 text-white'
                            }`}
                    >
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                        {saving ? 'Creating…' : 'Create Campaign (Draft)'}
                    </button>
                </div>

                <div className="space-y-6">
                    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                        <div className="flex items-center gap-2 text-gray-900 font-bold">
                            <Users className="w-5 h-5 text-brand-600" />
                            Audience Estimate
                        </div>
                        <p className="text-sm text-gray-500 mt-1">Approximate recipients for the selected segment.</p>

                        <div className="mt-4">
                            {estimating ? (
                                <div className="flex items-center gap-2 text-sm text-gray-500">
                                    <Loader2 className="w-4 h-4 animate-spin" /> Estimating…
                                </div>
                            ) : (
                                <div className="text-4xl font-extrabold text-gray-900">{audienceCount ?? '—'}</div>
                            )}
                            <button
                                type="button"
                                onClick={estimate}
                                className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 text-sm font-semibold"
                            >
                                <MessageSquareText className="w-4 h-4" />
                                Recalculate
                            </button>
                        </div>
                    </div>

                    {segmentMode === 'custom' && (
                        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                            <h3 className="font-bold text-gray-900 text-sm mb-3">Variable Placeholders</h3>
                            <div className="space-y-1.5">
                                {['{name}', '{phone}', '{amount}', '{due_date}', '{asset_model}', '{dealer_name}'].map(v => (
                                    <button key={v} onClick={() => setMessage(m => m + ' ' + v)} className="inline-block mr-2 px-2.5 py-1 bg-gray-50 border border-gray-200 rounded-lg text-xs font-mono text-gray-600 hover:bg-gray-100">
                                        {v}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="p-4 rounded-2xl bg-blue-50 border border-blue-200 text-blue-900 text-sm">
                        Campaign notes:
                        <ul className="list-disc pl-5 mt-2 space-y-1">
                            <li>Campaign is created as <span className="font-semibold">draft</span>.</li>
                            <li>Custom segments use {customLogic === 'and' ? 'AND' : 'OR'} logic to combine rules.</li>
                            <li>Scheduling and delivery provider integration available.</li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    );
}