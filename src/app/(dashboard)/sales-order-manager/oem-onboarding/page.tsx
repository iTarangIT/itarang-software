import { db } from '@/lib/db';
import { oems, oemContacts } from '@/lib/db/schema';
import { desc } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { Building2, Plus } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function SOMOemOnboardingPage() {
    await requireAuth();

    const allOems = await db.select()
        .from(oems)
        .orderBy(desc(oems.created_at));

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-3xl font-black text-gray-900">OEM Partners</h1>
                    <p className="text-sm text-gray-500 mt-1 uppercase tracking-widest font-bold">Manage OEM onboarding and relationships</p>
                </div>
                <Link href="/oem-onboarding">
                    <button className="flex items-center gap-2 bg-gray-900 text-white px-6 py-2.5 rounded-xl text-sm font-bold hover:bg-black transition-colors">
                        <Plus className="w-4 h-4" /> Onboard OEM
                    </button>
                </Link>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">OEM ID</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Business Name</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">GSTIN</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Location</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {allOems.map((oem) => (
                            <tr key={oem.id} className="hover:bg-gray-50 transition-colors">
                                <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-900">{oem.id}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{oem.business_entity_name}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-600">{oem.gstin}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">{oem.city || '—'}, {oem.state || '—'}</td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                    <span className={`px-3 py-1 rounded-full text-xs font-bold ${oem.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                                        {oem.status.toUpperCase()}
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {allOems.length === 0 && (
                    <div className="p-12 text-center text-gray-500 bg-gray-50/50">
                        <Building2 className="w-12 h-12 text-gray-200 mx-auto mb-3" />
                        <p className="font-medium">No OEMs onboarded yet.</p>
                        <p className="text-sm">Use the Onboard OEM button to add your first partner.</p>
                    </div>
                )}
            </div>
        </div>
    );
}
