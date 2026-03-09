
import { db } from '@/lib/db';
import { oemInventoryForPDI, inventory, products, oems, provisions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { format } from 'timeago.js';

export const dynamic = 'force-dynamic';

async function getPendingPDI() {
    const rows = await db.select({
        id: oemInventoryForPDI.id,
        serial_number: oemInventoryForPDI.serial_number,
        pdi_status: oemInventoryForPDI.pdi_status,
        product: {
            id: products.id,
            model_type: products.name,
            asset_type: products.asset_type,
        },
        oem: {
            id: oems.id,
            name: oems.business_entity_name,
        },
        provision: {
            id: provisions.id,
            expected_delivery: provisions.expected_delivery_date,
        }
    })
        .from(oemInventoryForPDI)
        .leftJoin(inventory, eq(oemInventoryForPDI.inventory_id, inventory.id))
        .leftJoin(products, eq(inventory.product_id, products.id))
        .leftJoin(oems, eq(oemInventoryForPDI.oem_id, oems.id))
        .leftJoin(provisions, eq(oemInventoryForPDI.provision_id, provisions.id))
        .where(eq(oemInventoryForPDI.pdi_status, 'pending'));

    return rows;
}

export default async function ServiceEngineerDashboard() {
    const items = await getPendingPDI();

    return (
        <div className="min-h-screen bg-brand-50/30 p-4 md:p-8">
            <header className="mb-8">
                <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Service Engineer Dashboard</h1>
                <p className="text-gray-500 mt-2">Manage your pending inspections and validations.</p>
            </header>

            <section>
                <div className="flex items-center justify-between mb-6">
                    <h2 className="text-xl font-semibold text-gray-800">Pending Inspections</h2>
                    <span className="bg-brand-100 text-brand-700 px-3 py-1 rounded-full text-sm font-medium">
                        {items.length} Tasks
                    </span>
                </div>

                {items.length === 0 ? (
                    <div className="bg-white rounded-2xl p-8 text-center shadow-soft border border-gray-100">
                        <p className="text-gray-500">No pending inspections found.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {items.map((item) => (
                            <div key={item.id} className="bg-white rounded-2xl p-6 shadow-card hover:shadow-soft transition-all duration-300 border border-gray-100 group">
                                <div className="flex justify-between items-start mb-4">
                                    <div>
                                        <span className="inline-block px-2 py-1 bg-yellow-50 text-yellow-700 text-xs font-semibold rounded-md mb-2">
                                            {item.product?.asset_type || 'Asset'}
                                        </span>
                                        <h3 className="text-lg font-bold text-gray-900 group-hover:text-brand-600 transition-colors">
                                            {item.product?.model_type || 'Unknown Model'}
                                        </h3>
                                        <p className="text-sm text-gray-500 font-mono mt-1">
                                            SN: {item.serial_number || 'N/A'}
                                        </p>
                                    </div>
                                    <div className="text-right">
                                        <p className="text-xs text-gray-400">OEM</p>
                                        <p className="text-sm font-medium text-gray-700 max-w-[120px] truncate" title={item.oem?.name || ''}>
                                            {item.oem?.name || 'Unknown'}
                                        </p>
                                    </div>
                                </div>

                                <div className="border-t border-gray-100 pt-4 mt-2">
                                    <div className="flex justify-between items-center text-sm text-gray-500 mb-4">
                                        <span>Due:</span>
                                        <span className="font-medium text-gray-700">
                                            {item.provision?.expected_delivery ? new Date(item.provision.expected_delivery).toLocaleDateString() : 'ASAP'}
                                        </span>
                                    </div>

                                    <Link
                                        href={`/dashboard/service-engineer/pdi/${item.id}`}
                                        className="block w-full text-center bg-brand-500 hover:bg-brand-600 text-white font-semibold py-3 px-4 rounded-xl transition-colors shadow-sm active:transform active:scale-95"
                                    >
                                        Start Inspection
                                    </Link>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}
