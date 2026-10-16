'use client';

// ID 173 — the older Inventory › Bulk upload. Same rule as Admin › Inventory ›
// Bulk Upload (src/lib/inventory/stockUploadRules.ts): Admin, Inventory
// Manager and partner pick any dealer; a dealer login uploads only to its own
// account (no picker); everyone else sees a refusal. The file is read in the
// browser and sent as rows — the route takes JSON, not a file.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, FileDown, CheckCircle, XCircle, AlertCircle, FileSpreadsheet } from 'lucide-react';
import { toast } from 'sonner';
import { ASSET_TYPES, CSV_TEMPLATES, buildCsvContent, unwrapCsvCell, type AssetType } from '@/lib/inventory/csv-templates';

type UploadMode = 'any' | 'own' | 'none';

interface DealerOption {
    id: string;
    business_entity_name: string;
    dealer_code?: string | null;
}

interface UploadResult {
    uploadEventId: string;
    totalRows: number;
    imported: number;
    skipped: number;
    errors: Array<{ row: number; field: string; code: string; message: string }>;
}

async function readRows(file: File): Promise<Record<string, unknown>[]> {
    const XLSX = await import('xlsx');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: false, raw: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return [];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
    return rows
        .map((r) => {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(r)) out[k.trim().toLowerCase()] = unwrapCsvCell(v);
            return out;
        })
        .filter((r) => Object.values(r).some((v) => String(v ?? '').trim() !== ''));
}

export default function BulkUploadPage() {
    const [mode, setMode] = useState<UploadMode | null>(null);
    const [ownDealer, setOwnDealer] = useState<{ id: string; name: string | null } | null>(null);
    const [dealers, setDealers] = useState<DealerOption[]>([]);
    const [dealerId, setDealerId] = useState('');
    const [assetType, setAssetType] = useState<AssetType>('battery');
    const [file, setFile] = useState<File | null>(null);
    const [uploading, setUploading] = useState(false);
    const [results, setResults] = useState<UploadResult | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/inventory/bulk-upload');
                const json = await res.json();
                const m: UploadMode = json?.data?.mode ?? 'none';
                setMode(m);
                setOwnDealer(json?.data?.ownDealer ?? null);
                if (m === 'any') {
                    const d = await fetch('/api/admin/dealers?limit=500').then((r) => r.json());
                    if (d?.success) setDealers(d.data || []);
                }
            } catch {
                setMode('none');
            }
        })();
    }, []);

    const targetName = useMemo(() => {
        if (mode === 'own') return ownDealer?.name || ownDealer?.id || '';
        return dealers.find((d) => d.id === dealerId)?.business_entity_name || '';
    }, [mode, ownDealer, dealers, dealerId]);

    const canUpload = !!file && (mode === 'own' ? !!ownDealer : mode === 'any' ? !!dealerId : false);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setFile(e.target.files[0]);
            setResults(null);
        }
    };

    const handleUpload = async () => {
        if (!file || !canUpload) return;

        setUploading(true);
        try {
            const rows = await readRows(file);
            if (rows.length === 0) {
                toast.error('The file has no rows.');
                return;
            }
            const res = await fetch('/api/inventory/bulk-upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // A dealer login never names the account: the server takes its own.
                body: JSON.stringify({ dealerId: mode === 'any' ? dealerId : undefined, assetType, rows }),
            });

            const data = await res.json();
            if (data.success) {
                setResults(data.data);
            } else {
                toast.error('Upload refused: ' + (data.error?.message || res.statusText));
            }
        } catch (error) {
            console.error('Upload error:', error);
            toast.error('An error occurred during upload.');
        } finally {
            setUploading(false);
        }
    };

    const downloadSample = () => {
        const template = CSV_TEMPLATES[assetType];
        const blob = new Blob([buildCsvContent(template)], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `inventory_${assetType}_template.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    if (mode === null) {
        return <div className="min-h-screen py-8 px-4 text-sm text-gray-500">Loading…</div>;
    }

    if (mode === 'none' || (mode === 'own' && !ownDealer)) {
        return (
            <div className="min-h-screen py-8 px-4 sm:px-6 lg:px-8">
                <div className="max-w-3xl mx-auto">
                    <h1 className="text-2xl font-bold text-gray-800 mb-4">Bulk Inventory Upload</h1>
                    <div className="bg-amber-50 p-4 rounded-xl border border-amber-200 flex gap-3 text-sm text-amber-900">
                        <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                        <span>
                            {mode === 'own'
                                ? 'Your login is not linked to a dealer account, so stock cannot be added. Ask iTarang to link it.'
                                : 'Only Admin, the Inventory Manager, the partner login or the dealer itself can add stock.'}
                        </span>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen py-8 px-4 sm:px-6 lg:px-8">
            <div className="max-w-3xl mx-auto">
                <div className="mb-8">
                    <h1 className="text-2xl font-bold text-gray-800">Bulk Inventory Upload</h1>
                    <p className="text-gray-500 mt-1">Upload a CSV or Excel file to add stock</p>
                </div>

                <div className="card-parcel space-y-8">
                    {/* Dealer: picked by Admin / Inventory Manager / partner; fixed for a dealer login. */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <label className="block text-sm">
                            <span className="font-medium text-gray-700">Dealer</span>
                            {mode === 'own' ? (
                                <p className="mt-1 px-3 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-800">
                                    {targetName} <span className="text-xs text-gray-500">(your account)</span>
                                </p>
                            ) : (
                                <select
                                    value={dealerId}
                                    onChange={(e) => setDealerId(e.target.value)}
                                    className="mt-1 w-full px-3 py-2 rounded-xl border border-gray-200 bg-white"
                                >
                                    <option value="">Pick a dealer…</option>
                                    {dealers.map((d) => (
                                        <option key={d.id} value={d.id}>
                                            {d.business_entity_name}{d.dealer_code ? ` (${d.dealer_code})` : ''}
                                        </option>
                                    ))}
                                </select>
                            )}
                        </label>
                        <label className="block text-sm">
                            <span className="font-medium text-gray-700">Item type</span>
                            <select
                                value={assetType}
                                onChange={(e) => { setAssetType(e.target.value as AssetType); setResults(null); }}
                                className="mt-1 w-full px-3 py-2 rounded-xl border border-gray-200 bg-white"
                            >
                                {ASSET_TYPES.map((t) => (
                                    <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                                ))}
                            </select>
                        </label>
                    </div>

                    {/* Instructions */}
                    <div className="bg-blue-50/50 p-4 rounded-xl border border-blue-100 flex gap-3">
                        <AlertCircle className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
                        <div className="text-sm text-blue-900">
                            <p className="font-medium mb-1">Upload Instructions:</p>
                            <ul className="list-disc ml-4 space-y-1 text-blue-800">
                                <li>Supported formats: <strong>.csv, .xlsx</strong>. One row per item.</li>
                                <li>Use the template for the item type: the column names must match.</li>
                                <li>Batteries and chargers need a serial number; serials must be unique.</li>
                            </ul>
                            <button
                                onClick={downloadSample}
                                className="mt-3 flex items-center gap-2 text-blue-700 hover:text-blue-900 font-medium transition-colors"
                            >
                                <FileDown className="w-4 h-4" />
                                Download {assetType} template
                            </button>
                        </div>
                    </div>

                    {/* Upload Area */}
                    <div className="border-2 border-dashed border-gray-200 rounded-2xl p-8 text-center transition-all hover:border-brand-300 hover:bg-brand-50/10">
                        <input
                            type="file"
                            ref={fileInputRef}
                            onChange={handleFileChange}
                            accept=".csv, .xlsx, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                            className="hidden"
                        />

                        <div className="flex flex-col items-center gap-4">
                            <div className="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center text-gray-400 mb-2">
                                {file ? <FileSpreadsheet className="w-8 h-8 text-brand-600" /> : <Upload className="w-8 h-8" />}
                            </div>

                            {file ? (
                                <div>
                                    <p className="text-lg font-medium text-gray-900">{file.name}</p>
                                    <p className="text-sm text-gray-500">{(file.size / 1024).toFixed(1)} KB</p>
                                    <button
                                        onClick={() => { setFile(null); setResults(null); }}
                                        className="mt-2 text-sm text-red-500 hover:text-red-600 font-medium"
                                    >
                                        Remove File
                                    </button>
                                </div>
                            ) : (
                                <div>
                                    <p className="text-lg font-medium text-gray-700">Pick your file</p>
                                    <button
                                        onClick={() => fileInputRef.current?.click()}
                                        className="mt-4 px-6 py-2 bg-white border border-gray-200 rounded-xl text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 transition-colors"
                                    >
                                        Browse Files
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Action Buttons */}
                    {file && !results && (
                        <div className="flex justify-end">
                            <button
                                onClick={handleUpload}
                                disabled={uploading || !canUpload}
                                className="btn-primary min-w-[160px]"
                            >
                                {uploading ? 'Processing...' : targetName ? `Add stock to ${targetName}` : 'Upload Inventory'}
                            </button>
                        </div>
                    )}

                    {/* Results */}
                    {results && (
                        <div className="border-t border-gray-100 pt-6 animate-in slide-in-from-top-4 fade-in">
                            <h3 className="text-lg font-bold text-gray-800 mb-4">Upload Results</h3>

                            <div className="grid grid-cols-2 gap-4 mb-6">
                                <div className="p-4 bg-green-50 rounded-xl border border-green-100 flex items-center gap-3">
                                    <CheckCircle className="w-8 h-8 text-green-600" />
                                    <div>
                                        <p className="text-2xl font-bold text-green-700">{results.imported}</p>
                                        <p className="text-xs font-medium text-green-600 uppercase tracking-wide">Added</p>
                                    </div>
                                </div>
                                <div className="p-4 bg-red-50 rounded-xl border border-red-100 flex items-center gap-3">
                                    <XCircle className="w-8 h-8 text-red-600" />
                                    <div>
                                        <p className="text-2xl font-bold text-red-700">{results.skipped}</p>
                                        <p className="text-xs font-medium text-red-600 uppercase tracking-wide">Skipped Rows</p>
                                    </div>
                                </div>
                            </div>

                            {results.errors.length > 0 && (
                                <div className="bg-gray-50 rounded-xl border border-gray-200 overflow-hidden">
                                    <div className="px-4 py-3 border-b border-gray-200 bg-gray-100/50">
                                        <h4 className="text-sm font-semibold text-gray-700">Error Log</h4>
                                    </div>
                                    <div className="max-h-60 overflow-y-auto p-4 space-y-2">
                                        {results.errors.map((err, idx) => (
                                            <div key={idx} className="flex gap-2 text-sm text-red-600">
                                                <span className="font-mono bg-white px-1.5 py-0.5 rounded border border-gray-200 text-gray-600">Row {err.row}</span>
                                                <span>{err.message}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                            <p className="mt-4 text-xs text-gray-500">Upload batch {results.uploadEventId}</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
