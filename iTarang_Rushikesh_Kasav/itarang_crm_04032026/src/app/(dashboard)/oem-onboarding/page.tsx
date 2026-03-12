
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, User, Phone, Mail, Upload, CheckCircle, AlertCircle, FileText } from 'lucide-react';
import { useRef } from 'react';

const CONTACT_ROLES = [
    { id: 'sales_head', label: 'Sales Head' },
    { id: 'sales_manager', label: 'Sales Manager' },
    { id: 'finance_manager', label: 'Finance Manager' }
];

export default function OemOnboardingPage() {
    const router = useRouter();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [formData, setFormData] = useState({
        business_entity_name: '',
        gstin: '',
        cin: '',
        bank_account_number: '',
        ifsc_code: '',
        bank_proof: null as File | null,
        bank_proof_url: 'https://example.com/placeholder-proof.pdf', // Mock fallback
        contacts: {
            sales_head: { name: '', phone: '', email: '' },
            sales_manager: { name: '', phone: '', email: '' },
            finance_manager: { name: '', phone: '', email: '' },
        }
    });

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setFormData(prev => ({
                ...prev,
                bank_proof: e.target.files![0],
                bank_proof_url: `https://mock-storage.com/${e.target.files![0].name}`
            }));
        }
    };

    const handleContactChange = (role: string, field: string, value: string) => {
        setFormData(prev => ({
            ...prev,
            contacts: {
                ...prev.contacts,
                [role as keyof typeof prev.contacts]: {
                    ...prev.contacts[role as keyof typeof prev.contacts],
                    [field]: value
                }
            }
        }));
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            // Transform contacts to array format expected by API
            const payload = {
                ...formData,
                contacts: CONTACT_ROLES.map(role => ({
                    contact_role: role.id,
                    contact_name: formData.contacts[role.id as keyof typeof formData.contacts].name,
                    contact_phone: formData.contacts[role.id as keyof typeof formData.contacts].phone,
                    contact_email: formData.contacts[role.id as keyof typeof formData.contacts].email,
                }))
            };

            const res = await fetch('/api/oems', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            let data;
            try {
                data = await res.json();
            } catch (jsonErr) {
                throw new Error(`Server returned an invalid response (Status: ${res.status}). Please check logs.`);
            }

            if (!res.ok) {
                throw new Error(data.error?.message || `Failed to register OEM (Error ${res.status})`);
            }

            alert('OEM Onboarded Successfully!');
            router.push('/dashboard'); // or list view if it exists
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen py-8 px-4 sm:px-6 lg:px-8">
            <div className="max-w-4xl mx-auto">
                <div className="mb-8">
                    <h1 className="text-2xl font-bold text-gray-800">OEM Onboarding</h1>
                    <p className="text-gray-500 mt-1">Register new Original Equipment Manufacturers</p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-8">
                    {/* Company Details */}
                    <div className="card-parcel space-y-6">
                        <div className="flex items-center gap-3 pb-4 border-b border-gray-100">
                            <div className="p-2 bg-brand-50 rounded-lg text-brand-600">
                                <Building2 className="w-5 h-5" />
                            </div>
                            <h2 className="text-lg font-semibold text-gray-800">Company Information</h2>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">Business Entity Name</label>
                                <input
                                    required
                                    type="text"
                                    className="input-parcel"
                                    placeholder="Registered Company Name"
                                    value={formData.business_entity_name}
                                    onChange={e => setFormData({ ...formData, business_entity_name: e.target.value })}
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">CIN</label>
                                <input
                                    required
                                    type="text"
                                    className="input-parcel"
                                    placeholder="Corporate Identity Number"
                                    value={formData.cin}
                                    onChange={e => setFormData({ ...formData, cin: e.target.value })}
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">GSTIN</label>
                                <input
                                    required
                                    type="text"
                                    className="input-parcel"
                                    placeholder="22AAAAA0000A1Z5"
                                    value={formData.gstin}
                                    onChange={e => setFormData({ ...formData, gstin: e.target.value.toUpperCase() })}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Bank Details */}
                    <div className="card-parcel space-y-6">
                        <div className="flex items-center gap-3 pb-4 border-b border-gray-100">
                            <div className="p-2 bg-purple-50 rounded-lg text-purple-600">
                                <AlertCircle className="w-5 h-5" />
                            </div>
                            <h2 className="text-lg font-semibold text-gray-800">Bank Details</h2>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">Account Number</label>
                                <input
                                    required
                                    type="text"
                                    className="input-parcel"
                                    placeholder="Account Number"
                                    value={formData.bank_account_number}
                                    onChange={e => setFormData({ ...formData, bank_account_number: e.target.value })}
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">IFSC Code</label>
                                <input
                                    required
                                    type="text"
                                    className="input-parcel"
                                    placeholder="HDFC0001234"
                                    value={formData.ifsc_code}
                                    onChange={e => setFormData({ ...formData, ifsc_code: e.target.value.toUpperCase() })}
                                />
                            </div>
                            <div className="md:col-span-2">
                                <label className="block text-sm font-medium text-gray-700 mb-2">Bank Proof (URL/File)</label>
                                <div className="flex gap-4">
                                    <div className="relative flex-1">
                                        <FileText className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                                        <input
                                            type="text"
                                            readOnly
                                            className="input-parcel pl-10 bg-gray-50 text-gray-600 cursor-default"
                                            value={formData.bank_proof ? formData.bank_proof.name : 'No file selected'}
                                        />
                                    </div>
                                    <input
                                        type="file"
                                        ref={fileInputRef}
                                        className="hidden"
                                        accept=".pdf,.jpg,.jpeg,.png"
                                        onChange={handleFileChange}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => fileInputRef.current?.click()}
                                        className="px-6 py-2 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 text-sm font-medium text-gray-700 shadow-sm transition-all flex items-center gap-2"
                                    >
                                        <Upload className="w-4 h-4" />
                                        Upload
                                    </button>
                                </div>
                                <p className="text-xs text-gray-400 mt-2 italic shadow-sm bg-gray-50/50 p-2 rounded-lg border border-gray-100/50 inline-block">
                                    * Supports PDF, JPG, PNG. Max size 5MB.
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Key Contacts */}
                    <div className="card-parcel space-y-6">
                        <div className="flex items-center gap-3 pb-4 border-b border-gray-100">
                            <div className="p-2 bg-blue-50 rounded-lg text-blue-600">
                                <User className="w-5 h-5" />
                            </div>
                            <h2 className="text-lg font-semibold text-gray-800">Key Contacts</h2>
                        </div>

                        <div className="grid grid-cols-1 gap-8">
                            {CONTACT_ROLES.map((role) => (
                                <div key={role.id} className="p-4 bg-gray-50/50 rounded-xl border border-gray-100 relative group hover:bg-white hover:shadow-sm transition-all">
                                    <h3 className="text-sm font-bold text-gray-900 mb-4 uppercase tracking-wide flex items-center gap-2">
                                        {role.label}
                                        <span className="text-red-500 text-xs">*</span>
                                    </h3>
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                        <div>
                                            <input
                                                required
                                                type="text"
                                                className="input-parcel bg-white"
                                                placeholder="Full Name"
                                                value={formData.contacts[role.id as keyof typeof formData.contacts].name}
                                                onChange={e => handleContactChange(role.id, 'name', e.target.value)}
                                            />
                                        </div>
                                        <div className="relative">
                                            <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                                            <input
                                                required
                                                type="tel"
                                                className="input-parcel pl-10 bg-white"
                                                placeholder="+91-9876543210"
                                                value={formData.contacts[role.id as keyof typeof formData.contacts].phone}
                                                onChange={e => handleContactChange(role.id, 'phone', e.target.value)}
                                            />
                                        </div>
                                        <div className="relative">
                                            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                                            <input
                                                required
                                                type="email"
                                                className="input-parcel pl-10 bg-white"
                                                placeholder="email@company.com"
                                                value={formData.contacts[role.id as keyof typeof formData.contacts].email}
                                                onChange={e => handleContactChange(role.id, 'email', e.target.value)}
                                            />
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {error && (
                        <div className="p-4 bg-red-50 text-red-600 rounded-xl text-sm font-medium flex items-center gap-2">
                            <AlertCircle className="w-4 h-4" />
                            {error}
                        </div>
                    )}

                    <div className="flex justify-end pt-4">
                        <button
                            type="submit"
                            disabled={loading}
                            className="btn-primary min-w-[200px]"
                        >
                            {loading ? 'Registering...' : 'Register OEM'}
                            {!loading && <CheckCircle className="w-4 h-4" />}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
