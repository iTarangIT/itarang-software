import { db } from '@/lib/db';
import { provisions } from '@/lib/db/schema';
import { desc } from 'drizzle-orm';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Plus, Package, Clock, CheckCircle, Truck, AlertCircle } from 'lucide-react';
import { requireAuth } from '@/lib/auth-utils';

export const dynamic = 'force-dynamic';

const STATUS_CONFIG: Record<string, { label: string, color: string, icon: any }> = {
    pending: { label: 'Pending', color: 'bg-yellow-100 text-yellow-800 border-yellow-200', icon: Clock },
    acknowledged: { label: 'Acknowledged', color: 'bg-blue-100 text-blue-800 border-blue-200', icon: CheckCircle },
    in_production: { label: 'In Production', color: 'bg-purple-100 text-purple-800 border-purple-200', icon: Truck },
    ready_for_pdi: { label: 'Ready for PDI', color: 'bg-green-100 text-green-800 border-green-200', icon: AlertCircle },
    completed: { label: 'Completed', color: 'bg-gray-100 text-gray-800 border-gray-200', icon: CheckCircle },
    cancelled: { label: 'Cancelled', color: 'bg-red-100 text-red-800 border-red-200', icon: AlertCircle },
};

export default async function ProvisionsPage() {
    await requireAuth();

    const allProvisions = await db.select()
        .from(provisions)
        .orderBy(desc(provisions.created_at));

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Provisions</h1>
                    <p className="text-sm text-gray-500 mt-1">Track asset procurement requests from OEMs</p>
                </div>
                <Link href="/provisions/new">
                    <Button variant="primary">
                        <Plus className="w-4 h-4 mr-2" />
                        Create Provision
                    </Button>
                </Link>
            </div>

            <div className="grid gap-6">
                {allProvisions.map((prov) => {
                    const status = STATUS_CONFIG[prov.status] || STATUS_CONFIG.pending;
                    const StatusIcon = status.icon;

                    return (
                        <div key={prov.id} className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow">
                            <div className="flex justify-between items-start mb-4">
                                <div>
                                    <div className="flex items-center gap-3 mb-1">
                                        <h3 className="text-lg font-bold text-gray-900">{prov.id}</h3>
                                        <span className={`px-3 py-1 rounded-full text-xs font-bold border flex items-center gap-1.5 ${status.color}`}>
                                            <StatusIcon className="w-3.5 h-3.5" />
                                            {status.label.toUpperCase()}
                                        </span>
                                    </div>
                                    <p className="text-sm font-medium text-brand-600">{prov.oem_name}</p>
                                </div>
                                <div className="text-right">
                                    <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-1">Expected Delivery</p>
                                    <p className="text-sm font-bold text-gray-800">
                                        {new Date(prov.expected_delivery_date).toLocaleDateString('en-IN', {
                                            day: '2-digit',
                                            month: 'short',
                                            year: 'numeric'
                                        })}
                                    </p>
                                </div>
                            </div>

                            <div className="border-t border-gray-100 pt-4 mt-4">
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                    {((prov.products as any[]) || []).map((prod, idx) => (
                                        <div key={idx} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                                            <div className="p-2 bg-white rounded-lg border border-gray-200">
                                                <Package className="w-4 h-4 text-gray-400" />
                                            </div>
                                            <div>
                                                <p className="text-xs text-gray-500 font-medium truncate">{prod.model_type}</p>
                                                <p className="text-sm font-bold text-gray-900">{prod.quantity} Units</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="mt-6 flex justify-end gap-3">
                                <Link href={`/provisions/${prov.id}`}>
                                    <Button variant="outline" size="sm">View Details</Button>
                                </Link>
                                {prov.status === 'ready_for_pdi' && (
                                    <Link href={`/service-engineer/pdi/provision/${prov.id}`}>
                                        <Button variant="primary" size="sm">Start PDI</Button>
                                    </Link>
                                )}
                            </div>
                        </div>
                    );
                })}

                {allProvisions.length === 0 && (
                    <div className="bg-white rounded-2xl border border-dashed border-gray-300 p-20 text-center">
                        <div className="bg-gray-50 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                            <Plus className="w-8 h-8 text-gray-300" />
                        </div>
                        <h3 className="text-lg font-bold text-gray-400">No Provisions Found</h3>
                        <p className="text-sm text-gray-400 mt-1">Start by creating your first procurement request.</p>
                        <Link href="/provisions/new" className="mt-6 inline-block">
                            <Button variant="outline">Create Provision</Button>
                        </Link>
                    </div>
                )}
            </div>
        </div>
    );
}
