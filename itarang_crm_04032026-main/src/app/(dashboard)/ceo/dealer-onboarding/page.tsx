import { db } from '@/lib/db';
import { dealerOnboardings, accounts } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { Building, Mail, Phone, MapPin, CheckCircle, FileText, AlertCircle, Eye, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { format } from 'date-fns';

export default async function DealerOnboardingPage() {
    // Fetch dealer onboarding records
    const onboardingsData = await db
        .select({
            id: dealerOnboardings.id,
            business_name: dealerOnboardings.business_name,
            owner_name: dealerOnboardings.owner_name,
            email: dealerOnboardings.email,
            phone: dealerOnboardings.phone,
            gstin: dealerOnboardings.gstin,
            pan: dealerOnboardings.pan,
            address: dealerOnboardings.address,
            signzy_status: dealerOnboardings.signzy_status,
            signzy_document_url: dealerOnboardings.signzy_document_url,
            created_at: dealerOnboardings.created_at,
        })
        .from(dealerOnboardings)
        .orderBy(desc(dealerOnboardings.created_at));

    const pendingCount = onboardingsData.filter(d => d.signzy_status === 'pending' || d.signzy_status === 'sent').length;
    const completedCount = onboardingsData.filter(d => d.signzy_status === 'signed').length;

    return (
        <div className="max-w-7xl mx-auto space-y-6">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-slate-900">Dealer Onboarding Applications</h1>
                    <p className="text-sm text-slate-500 mt-1">
                        Review, verify, and approve new dealer partnerships via Signzy.
                    </p>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-gradient-to-br from-blue-500 to-indigo-600 p-6 rounded-2xl text-white shadow-blue-200/50 shadow-lg">
                    <div className="flex items-center justify-between mb-4">
                        <Building className="w-6 h-6 text-blue-100" />
                        <span className="bg-blue-400/30 text-xs font-semibold px-2 py-1 rounded-full">Total Applications</span>
                    </div>
                    <p className="text-3xl font-bold tracking-tight">{onboardingsData.length}</p>
                    <p className="text-blue-100 text-sm mt-1">In your pipeline</p>
                </div>
                <div className="bg-gradient-to-br from-amber-500 to-orange-500 p-6 rounded-2xl text-white shadow-orange-200/50 shadow-lg">
                    <div className="flex items-center justify-between mb-4">
                        <AlertCircle className="w-6 h-6 text-orange-100" />
                        <span className="bg-orange-400/30 text-xs font-semibold px-2 py-1 rounded-full">Pending E-Sign</span>
                    </div>
                    <p className="text-3xl font-bold tracking-tight">{pendingCount}</p>
                    <p className="text-orange-100 text-sm mt-1">Waiting on dealer signature</p>
                </div>
                <div className="bg-gradient-to-br from-emerald-500 to-teal-500 p-6 rounded-2xl text-white shadow-emerald-200/50 shadow-lg">
                    <div className="flex items-center justify-between mb-4">
                        <CheckCircle className="w-6 h-6 text-emerald-100" />
                        <span className="bg-emerald-400/30 text-xs font-semibold px-2 py-1 rounded-full">Signed & Verified</span>
                    </div>
                    <p className="text-3xl font-bold tracking-tight">{completedCount}</p>
                    <p className="text-emerald-100 text-sm mt-1">Ready for account creation</p>
                </div>
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
                <div className="p-6 border-b border-slate-100">
                    <h2 className="text-lg font-semibold text-slate-800">Recent Applications</h2>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left">
                        <thead className="bg-slate-50 text-slate-500 uppercase font-medium text-xs">
                            <tr>
                                <th className="px-6 py-4 rounded-tl-xl whitespace-nowrap">Business Details</th>
                                <th className="px-6 py-4">Contact Info</th>
                                <th className="px-6 py-4">Tax IDs</th>
                                <th className="px-6 py-4">Signzy Status</th>
                                <th className="px-6 py-4 text-right rounded-tr-xl">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {onboardingsData.length === 0 ? (
                                <tr>
                                    <td colSpan={5} className="px-6 py-12 text-center text-slate-500">
                                        <div className="flex justify-center bg-slate-50 w-16 h-16 rounded-full items-center mx-auto mb-3">
                                            <Building className="w-8 h-8 text-slate-400" />
                                        </div>
                                        <p className="text-base font-semibold text-slate-700">No applications found</p>
                                        <p className="text-sm mt-1">Dealer onboarding applications will appear here.</p>
                                    </td>
                                </tr>
                            ) : (
                                onboardingsData.map((app) => (
                                    <tr key={app.id} className="hover:bg-slate-50/50 transition-colors">
                                        <td className="px-6 py-4">
                                            <div className="font-semibold text-slate-900 text-base">{app.business_name}</div>
                                            <div className="text-sm text-slate-500 mt-1 flex items-center gap-1.5">
                                                <div className="w-5 h-5 bg-slate-100 rounded-full flex items-center justify-center text-xs font-bold text-slate-600">
                                                    {app.owner_name?.[0] || 'O'}
                                                </div>
                                                {app.owner_name}
                                            </div>
                                            <div className="text-xs text-slate-400 mt-1.5 flex items-center gap-1">
                                                <MapPin className="w-3 h-3" />
                                                <span className="truncate max-w-[150px] inline-block">{app.address}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex flex-col gap-2">
                                                <div className="flex items-center gap-2 text-slate-600 text-sm">
                                                    <Mail className="w-4 h-4 text-slate-400" />
                                                    <a href={`mailto:${app.email}`} className="hover:text-brand-600 transition-colors">{app.email}</a>
                                                </div>
                                                <div className="flex items-center gap-2 text-slate-600 text-sm">
                                                    <Phone className="w-4 h-4 text-slate-400" />
                                                    <a href={`tel:${app.phone}`} className="hover:text-brand-600 transition-colors">{app.phone}</a>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex flex-col gap-1.5">
                                                <div className="flex items-center gap-1 text-xs">
                                                    <span className="text-slate-400 uppercase w-10">GSTIN</span>
                                                    <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">{app.gstin}</span>
                                                </div>
                                                <div className="flex items-center gap-1 text-xs">
                                                    <span className="text-slate-400 uppercase w-10">PAN</span>
                                                    <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">{app.pan}</span>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex flex-col items-start gap-2">
                                                {app.signzy_status === 'signed' ? (
                                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200/60">
                                                        <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full" />
                                                        E-Signed
                                                    </span>
                                                ) : app.signzy_status === 'sent' ? (
                                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200/60">
                                                        <span className="w-1.5 h-1.5 bg-amber-500 rounded-full" />
                                                        Link Sent
                                                    </span>
                                                ) : app.signzy_status === 'failed' ? (
                                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-50 text-red-700 border border-red-200/60">
                                                        <span className="w-1.5 h-1.5 bg-red-500 rounded-full" />
                                                        Failed
                                                    </span>
                                                ) : (
                                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">
                                                        {app.signzy_status || 'Pending'}
                                                    </span>
                                                )}
                                                
                                                {app.signzy_document_url && (
                                                    <a 
                                                        href={app.signzy_document_url} 
                                                        target="_blank" 
                                                        className="text-[11px] text-brand-600 hover:text-brand-700 flex items-center gap-1 font-medium bg-brand-50 px-2 py-1 rounded"
                                                    >
                                                        <FileText className="w-3 h-3" />
                                                        View Document
                                                        <ExternalLink className="w-3 h-3 ml-0.5" />
                                                    </a>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <button className="p-2 text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors inline-flex items-center justify-center">
                                                <Eye className="w-5 h-5" />
                                            </button>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
