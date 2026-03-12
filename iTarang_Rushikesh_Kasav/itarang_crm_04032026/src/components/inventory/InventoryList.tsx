'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import { DataTable } from '@/components/shared/data-table';
import { Download, Loader2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

type InventoryItem = {
    id: string;
    serial_number: string | null;
    status: string;
    inventory_amount: number;
    gst_amount: number;
    final_amount: number;
    uploaded_at: string;
    iot_imei_no: string | null;
    oem_invoice_number: string | null;
    warehouse_location: string | null;
    oem_id: string;
    product: {
        hsn_code: string;
        asset_category: string;
        asset_type: string;
        model_type: string;
    };
};

export default function InventoryList() {
    const [filters, setFilters] = useState({
        asset_category: '',
        status: ''
    });

    const { data, isLoading, error } = useQuery({
        queryKey: ['inventory', filters],
        queryFn: async () => {
            const params = new URLSearchParams();
            if (filters.asset_category) params.append('asset_category', filters.asset_category);
            if (filters.status) params.append('status', filters.status);

            const res = await fetch(`/api/inventory?${params.toString()}`);
            if (!res.ok) throw new Error('Failed to fetch inventory');
            const result = await res.json();
            return result.data as InventoryItem[];
        }
    });

    const handleExport = () => {
        if (!data) return;

        const exportData = data.map(item => ({
            'Serial Number': item.serial_number || 'N/A',
            'Category': item.product.asset_category,
            'Type': item.product.asset_type,
            'Model': item.product.model_type,
            'Status': item.status,
            'IMEI': item.iot_imei_no || 'N/A',
            'OEM Invoice No': item.oem_invoice_number || '-',
            'Warehouse': item.warehouse_location || '-',
            'Amount': item.inventory_amount,
            'GST': item.gst_amount,
            'Total': item.final_amount,
            'Date': new Date(item.uploaded_at).toLocaleDateString()
        }));

        const ws = XLSX.utils.json_to_sheet(exportData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Inventory");
        XLSX.writeFile(wb, "Inventory_Report.xlsx");
    };

    const columns: any[] = [
        { header: 'Serial No', accessorKey: 'serial_number', cell: (item: any) => <span className="font-mono text-xs">{item.serial_number || '-'}</span> },
        { header: 'Model', accessorKey: 'product.model_type', cell: (item: any) => item.product.model_type },
        { header: 'Category/Type', accessorKey: 'category_type', cell: (item: any) => `${item.product.asset_category} - ${item.product.asset_type}` },
        { header: 'Location', accessorKey: 'warehouse_location' },
        {
            header: 'Status',
            accessorKey: 'status',
            cell: (item: any) => (
                <span className={cn(
                    "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase",
                    item.status === 'available' ? "bg-emerald-50 text-emerald-600" :
                        item.status === 'sold' ? "bg-blue-50 text-blue-600" : "bg-gray-100 text-gray-600"
                )}>
                    {item.status}
                </span>
            )
        },
        {
            header: 'Price',
            accessorKey: 'final_amount',
            align: 'right',
            cell: (item: any) => <span className="font-bold">₹{item.final_amount.toLocaleString()}</span>
        },
    ];

    if (error) {
        return (
            <div className="p-8 rounded-2xl bg-red-50 border border-red-100 text-center">
                <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
                <h3 className="text-lg font-bold text-red-900">Inventory Sync Error</h3>
                <p className="text-sm text-red-600 mt-2">Could not connect to the inventory service.</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row justify-between items-end gap-4 bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                <div className="flex flex-wrap gap-4 flex-1">
                    <div className="space-y-1.5">
                        <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider ml-1">Asset Category</label>
                        <select
                            className="flex h-10 w-full rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 min-w-[160px]"
                            value={filters.asset_category}
                            onChange={(e) => setFilters(prev => ({ ...prev, asset_category: e.target.value }))}
                        >
                            <option value="">All Categories</option>
                            <option value="3W">3W</option>
                            <option value="2W">2W</option>
                            <option value="Inverter">Inverter</option>
                        </select>
                    </div>

                    <div className="space-y-1.5">
                        <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider ml-1">Stock Status</label>
                        <select
                            className="flex h-10 w-full rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 min-w-[160px]"
                            value={filters.status}
                            onChange={(e) => setFilters(prev => ({ ...prev, status: e.target.value }))}
                        >
                            <option value="">All Statuses</option>
                            <option value="available">Available</option>
                            <option value="sold">Sold</option>
                            <option value="defective">Defective</option>
                        </select>
                    </div>
                </div>

                <button
                    onClick={handleExport}
                    disabled={isLoading || !data?.length}
                    className="flex items-center gap-2 px-6 py-2.5 bg-brand-600 text-white text-xs font-bold rounded-xl shadow-lg shadow-brand-500/20 hover:bg-brand-700 transition-all disabled:opacity-50 disabled:shadow-none"
                >
                    <Download className="w-4 h-4" />
                    Export to Excel
                </button>
            </div>

            <div className="min-h-[400px] relative">
                {isLoading && (
                    <div className="absolute inset-0 bg-white/50 backdrop-blur-[1px] z-10 flex flex-col items-center justify-center gap-3">
                        <Loader2 className="w-8 h-8 text-brand-600 animate-spin" />
                        <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Refreshing Inventory...</p>
                    </div>
                )}

                <DataTable
                    data={data || []}
                    columns={columns}
                    searchPlaceholder="Filter Serial No, Model, or IMEI..."
                    pageSize={10}
                />
            </div>
        </div>
    );
}
