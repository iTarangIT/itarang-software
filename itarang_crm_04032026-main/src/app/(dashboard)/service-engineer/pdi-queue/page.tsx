import { db } from '@/lib/db';
import { oemInventoryForPDI, pdiRecords, inventory } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { Wrench, CheckCircle2, Clock, ArrowRight } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function PDIQueuePage() {
    await requireAuth();

    const pdiItems = await db.select()
        .from(oemInventoryForPDI)
        .orderBy(desc(oemInventoryForPDI.created_at));

    const pendingCount = pdiItems.filter(i => i.pdi_status === 'pending').length;
    const inProgressCount = pdiItems.filter(i => i.pdi_status === 'in_progress').length;
    const completedCount = pdiItems.filter(i => i.pdi_status === 'completed').length;

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
            <div className="mb-8">
                <h1 className="text-3xl font-black text-gray-900">PDI Queue</h1>
                <p className="text-sm text-gray-500 mt-1 uppercase tracking-widest font-bold">Pre-Delivery Inspection queue for incoming inventory</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                <div className="bg-white p-6 rounded-2xl border border-orange-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Pending</p>
                    <p className="text-3xl font-black text-orange-600">{pendingCount}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-blue-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">In Progress</p>
                    <p className="text-3xl font-black text-blue-600">{inProgressCount}</p>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-green-100 shadow-sm">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Completed</p>
                    <p className="text-3xl font-black text-green-600">{completedCount}</p>
                </div>
            </div>

            <div className="space-y-4">
                {pdiItems.map((item) => (
                    <div key={item.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 hover:shadow-md transition-shadow">
                        <div className="flex justify-between items-center">
                            <div className="flex items-center gap-4">
                                <div className={`p-3 rounded-xl border ${item.pdi_status === 'completed' ? 'bg-green-50 border-green-100 text-green-600' : item.pdi_status === 'in_progress' ? 'bg-blue-50 border-blue-100 text-blue-600' : 'bg-orange-50 border-orange-100 text-orange-600'}`}>
                                    <Wrench className="w-6 h-6" />
                                </div>
                                <div>
                                    <h3 className="font-bold text-gray-900">{item.id}</h3>
                                    <p className="text-sm text-gray-500">Provision: {item.provision_id} | Serial: {item.serial_number || 'N/A'}</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-4">
                                <span className={`px-3 py-1 rounded-full text-xs font-bold ${item.pdi_status === 'completed' ? 'bg-green-100 text-green-700' : item.pdi_status === 'in_progress' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}`}>
                                    {item.pdi_status.replace(/_/g, ' ').toUpperCase()}
                                </span>
                                {item.pdi_status !== 'completed' && (
                                    <Link href={`/service-engineer/pdi/${item.id}`}>
                                        <button className="flex items-center gap-2 bg-gray-900 text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-black transition-colors">
                                            Start PDI <ArrowRight className="w-4 h-4" />
                                        </button>
                                    </Link>
                                )}
                            </div>
                        </div>
                    </div>
                ))}

                {pdiItems.length === 0 && (
                    <div className="bg-green-50/50 border-2 border-dashed border-green-100 rounded-3xl p-16 text-center">
                        <CheckCircle2 className="w-12 h-12 text-green-300 mx-auto mb-3" />
                        <h3 className="text-lg font-bold text-green-800">Queue Empty</h3>
                        <p className="text-sm text-green-600 font-medium">No items awaiting pre-delivery inspection.</p>
                    </div>
                )}
            </div>
        </div>
    );
}
