'use client';

import { type ReactNode, useState } from 'react';
import {
    ChevronLeft, ChevronDown, Loader2, AlertCircle, X,
    Upload, CheckCircle2, XCircle, Clock, Scan, Eye
} from 'lucide-react';

// ─── Section Card ───────────────────────────────────────────────────────────

export function SectionCard({ title, children, action }: {
    title: string;
    children: ReactNode;
    action?: ReactNode;
}) {
    return (
        <div className="bg-white rounded-[24px] border border-[#E9ECEF] shadow-[0_8px_30px_rgb(0,0,0,0.02)]">
            <div className="flex items-center justify-between px-8 pt-8 pb-4">
                <div className="flex items-center gap-4">
                    <div className="w-[3px] h-6 bg-[#0047AB] rounded-full" />
                    <h3 className="text-lg font-black text-gray-900 tracking-tight">{title}</h3>
                </div>
                {action}
            </div>
            <div className="px-8 pb-8 pt-2">{children}</div>
        </div>
    );
}

// ─── Input Field ────────────────────────────────────────────────────────────

export function InputField({ label, value, onChange, onBlur, error, placeholder, required, type = 'text', disabled, className }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    onBlur?: () => void;
    error?: string;
    placeholder?: string;
    required?: boolean;
    type?: string;
    disabled?: boolean;
    className?: string;
}) {
    return (
        <div className={`space-y-2 ${className || ''}`}>
            <label className="text-sm font-bold text-gray-900 px-1">
                {label} {required && <span className="text-red-500">*</span>}
            </label>
            <input
                type={type}
                value={value ?? ''}
                onChange={e => onChange(e.target.value)}
                onBlur={onBlur}
                placeholder={placeholder}
                disabled={disabled}
                className={`w-full h-11 px-4 bg-white border-2 rounded-xl outline-none transition-all text-sm placeholder-gray-400 ${
                    disabled ? 'bg-gray-50 border-[#F5F5F5] text-gray-400' :
                    error ? 'border-red-400 focus:border-red-500' :
                    'border-[#EBEBEB] focus:border-[#1D4ED8] focus:ring-4 focus:ring-blue-50/50'
                }`}
            />
            {error && <p className="text-[10px] text-red-500 font-bold px-1">{error}</p>}
        </div>
    );
}

// ─── Select Field ───────────────────────────────────────────────────────────

export function SelectField({ label, value, onChange, options, error, placeholder, required, disabled }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    options: { value: string; label: string }[];
    error?: string;
    placeholder?: string;
    required?: boolean;
    disabled?: boolean;
}) {
    return (
        <div className="space-y-2">
            <label className="text-sm font-bold text-gray-900 px-1">
                {label} {required && <span className="text-red-500">*</span>}
            </label>
            <div className="relative">
                <select
                    value={value ?? ''}
                    onChange={e => onChange(e.target.value)}
                    disabled={disabled}
                    className={`w-full h-11 px-4 pr-10 bg-white border-2 rounded-xl outline-none transition-all text-sm appearance-none ${
                        disabled ? 'bg-gray-50 border-[#F5F5F5] text-gray-400' :
                        error ? 'border-red-400' :
                        'border-[#EBEBEB] focus:border-[#1D4ED8] focus:ring-4 focus:ring-blue-50/50'
                    } ${!value ? 'text-gray-400' : 'text-gray-900'}`}
                >
                    <option value="">{placeholder || 'Select...'}</option>
                    {options.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            </div>
            {error && <p className="text-[10px] text-red-500 font-bold px-1">{error}</p>}
        </div>
    );
}

// ─── Text Area Field ────────────────────────────────────────────────────────

export function TextAreaField({ label, value, onChange, error, placeholder, required, disabled, rows = 2 }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    error?: string;
    placeholder?: string;
    required?: boolean;
    disabled?: boolean;
    rows?: number;
}) {
    return (
        <div className="space-y-2">
            <label className="text-sm font-bold text-gray-900 px-1">
                {label} {required && <span className="text-red-500">*</span>}
            </label>
            <textarea
                value={value ?? ''}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
                disabled={disabled}
                rows={rows}
                className={`w-full px-4 py-3 bg-white border-2 rounded-xl outline-none transition-all text-sm placeholder-gray-400 resize-none ${
                    disabled ? 'bg-gray-50 border-[#F5F5F5] text-gray-400' :
                    error ? 'border-red-400' :
                    'border-[#EBEBEB] focus:border-[#1D4ED8] focus:ring-4 focus:ring-blue-50/50'
                }`}
            />
            {error && <p className="text-[10px] text-red-500 font-bold px-1">{error}</p>}
        </div>
    );
}

// ─── Document Card ──────────────────────────────────────────────────────────

export type DocStatus = 'not_uploaded' | 'uploaded' | 'verified' | 'rejected' | 'reupload_requested' | 'pending';
export type VerificationStatus = 'pending' | 'initiating' | 'awaiting_action' | 'in_progress' | 'success' | 'failed';

// Dealer-facing status labels (simplified from internal statuses)
function getDealerStatus(uploaded: boolean, status?: string): { label: string; color: string; dotColor: string; icon: 'check' | 'error' | 'clock' | 'upload' | 'reupload' } {
    if (!uploaded) return { label: 'Not Uploaded', color: 'text-gray-400', dotColor: 'bg-gray-300', icon: 'upload' };
    const s = (status || '').toLowerCase();
    if (s === 'success' || s === 'verified') return { label: 'Verified', color: 'text-green-600', dotColor: 'bg-green-500', icon: 'check' };
    if (s === 'failed' || s === 'rejected' || s === 'reupload_requested') return { label: 'Reupload Required', color: 'text-red-600', dotColor: 'bg-red-500', icon: 'reupload' };
    return { label: 'Uploaded - Pending Review', color: 'text-blue-600', dotColor: 'bg-amber-500', icon: 'clock' };
}

export function DocumentCard({ label, required, uploaded, status, failedReason, onUpload, disabled, fileUrl }: {
    label: string;
    required?: boolean;
    uploaded: boolean;
    status?: string;
    failedReason?: string | null;
    onUpload: (file: File) => void;
    disabled?: boolean;
    fileUrl?: string | null;
}) {
    const dealerStatus = getDealerStatus(uploaded, status);

    return (
        <div className={`relative flex flex-col items-center border-2 rounded-2xl transition-all min-h-[130px] ${
            uploaded
                ? dealerStatus.icon === 'error' || dealerStatus.icon === 'reupload' ? 'border-red-200 bg-red-50'
                : dealerStatus.icon === 'check' ? 'border-green-200 bg-green-50'
                : 'border-blue-200 bg-blue-50'
                : 'border-dashed border-gray-200 bg-white'
        }`}>
            <label className={`flex flex-col items-center justify-center p-5 flex-1 w-full ${
                disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-[#0047AB]'
            }`}>
                <input
                    type="file"
                    className="hidden"
                    accept="image/png,image/jpeg,image/jpg,application/pdf"
                    disabled={disabled}
                    onChange={e => e.target.files?.[0] && onUpload(e.target.files[0])}
                />
                {/* Status dot */}
                <div className={`absolute top-3 right-3 w-2.5 h-2.5 rounded-full ${dealerStatus.dotColor}`} />

                {dealerStatus.icon === 'check' ? <CheckCircle2 className="w-6 h-6 text-green-500 mb-2" /> :
                 dealerStatus.icon === 'reupload' || dealerStatus.icon === 'error' ? <XCircle className="w-6 h-6 text-red-500 mb-2" /> :
                 dealerStatus.icon === 'clock' ? <Clock className="w-5 h-5 text-blue-500 mb-2" /> :
                 <Upload className="w-6 h-6 text-gray-300 mb-2" />}

                <span className="text-xs font-bold text-gray-700 text-center leading-tight">{label}</span>
                <span className={`text-[10px] font-semibold mt-1 text-center ${dealerStatus.color}`}>{dealerStatus.label}</span>
                {required && !uploaded && <span className="text-[10px] text-red-400 mt-0.5">Required</span>}
                {failedReason && <span className="text-[10px] text-red-500 mt-0.5 text-center px-1 leading-tight">{failedReason}</span>}
                {dealerStatus.icon === 'reupload' && <span className="text-[10px] text-[#0047AB] font-bold mt-1">Click to Re-upload</span>}
            </label>

            {uploaded && fileUrl && (
                <a
                    href={fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="flex items-center justify-center gap-1.5 w-full py-2 border-t border-gray-200 text-[11px] font-bold text-[#0047AB] hover:bg-blue-50 transition-colors rounded-b-2xl"
                >
                    <Eye className="w-3.5 h-3.5" />
                    View Document
                </a>
            )}
        </div>
    );
}

// ─── Status Badge ───────────────────────────────────────────────────────────

const BADGE_CONFIG: Record<string, { bg: string; text: string; label: string }> = {
    pending: { bg: 'bg-yellow-50', text: 'text-yellow-700', label: 'Pending' },
    initiating: { bg: 'bg-orange-50', text: 'text-orange-700', label: 'Initiating' },
    awaiting_action: { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Awaiting Action' },
    in_progress: { bg: 'bg-blue-50', text: 'text-blue-700', label: 'In Progress' },
    processing: { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Processing' },
    success: { bg: 'bg-green-50', text: 'text-green-700', label: 'Verified' },
    verified: { bg: 'bg-green-50', text: 'text-green-700', label: 'Verified' },
    failed: { bg: 'bg-red-50', text: 'text-red-700', label: 'Failed' },
    rejected: { bg: 'bg-red-50', text: 'text-red-700', label: 'Rejected' },
    uploaded: { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Uploaded' },
    not_uploaded: { bg: 'bg-gray-50', text: 'text-gray-500', label: 'Not Uploaded' },
};

export function StatusBadge({ status }: { status: string }) {
    const c = BADGE_CONFIG[status] || BADGE_CONFIG.pending;
    return <span className={`px-3 py-1 rounded-full text-xs font-bold ${c.bg} ${c.text}`}>{c.label}</span>;
}

// ─── Progress Header ────────────────────────────────────────────────────────

export function ProgressHeader({ title, subtitle, step, totalSteps = 5, onBack, rightAction }: {
    title: string;
    subtitle?: string;
    step: number;
    totalSteps?: number;
    onBack: () => void;
    rightAction?: ReactNode;
}) {
    return (
        <header className="mb-8 flex justify-between items-start gap-4">
            <div className="flex gap-4">
                <button onClick={onBack} className="mt-1 p-2 hover:bg-white transition-colors rounded-lg">
                    <ChevronLeft className="w-6 h-6 text-gray-900" />
                </button>
                <div>
                    <h1 className="text-[28px] font-black text-gray-900 leading-tight tracking-tight">{title}</h1>
                    {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
                </div>
            </div>
            <div className="flex flex-col items-end gap-4">
                <div>
                    <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest text-right mb-1.5">
                        Workflow Progress
                    </p>
                    <div className="flex items-center gap-6">
                        <span className="text-xs font-bold text-[#1D4ED8] whitespace-nowrap">
                            Step {step} of {totalSteps}
                        </span>
                        <div className="flex gap-2.5">
                            {Array.from({ length: totalSteps }, (_, i) => (
                                <div
                                    key={i}
                                    className={`h-[6px] w-[50px] rounded-full transition-all duration-300 ${
                                        i < step ? 'bg-[#0047AB]' : 'bg-gray-200'
                                    }`}
                                />
                            ))}
                        </div>
                    </div>
                </div>
                {rightAction}
            </div>
        </header>
    );
}

// ─── Sticky Bottom Bar ──────────────────────────────────────────────────────

export function StickyBottomBar({ children, lastSaved }: {
    children: ReactNode;
    lastSaved?: string | null;
}) {
    return (
        <div className="sticky bottom-0 left-0 right-0 bg-[#F8F9FB] pt-4 pb-8 z-50">
            <div className="max-w-[1200px] mx-auto px-6">
                <div className="flex justify-between items-center bg-white border border-gray-100 rounded-[20px] px-8 py-5 shadow-[0_-8px_30px_rgb(0,0,0,0.04)]">
                    <div className="bg-gray-100 px-4 py-1.5 rounded-full">
                        <span className="text-[11px] font-bold text-gray-500 uppercase tracking-widest">
                            {lastSaved || 'Not saved'}
                        </span>
                    </div>
                    <div className="flex gap-4">{children}</div>
                </div>
            </div>
        </div>
    );
}

// ─── Error Banner ───────────────────────────────────────────────────────────

export function ErrorBanner({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
    if (!message) return null;
    return (
        <div className="mb-6 bg-red-50 border border-red-200 p-4 rounded-xl flex items-center justify-between">
            <div className="flex items-center gap-3 text-red-700 font-medium text-sm">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                {message}
            </div>
            <button onClick={onDismiss} className="p-1 hover:bg-white rounded-md transition-colors">
                <X className="w-5 h-5" />
            </button>
        </div>
    );
}

// ─── Button Variants ────────────────────────────────────────────────────────

export function PrimaryButton({ children, onClick, disabled, loading, className }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
    className?: string;
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled || loading}
            className={`px-8 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${className || ''}`}
        >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {children}
        </button>
    );
}

export function SecondaryButton({ children, onClick, disabled, loading }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled || loading}
            className="px-8 py-2.5 border-2 border-[#0047AB] rounded-xl text-sm font-bold text-[#0047AB] hover:bg-blue-50 transition-all flex items-center gap-2 disabled:opacity-50"
        >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {children}
        </button>
    );
}

export function OutlineButton({ children, onClick, disabled }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className="px-8 py-2.5 border-2 border-[#EBEBEB] rounded-xl text-sm font-bold text-gray-700 hover:bg-gray-50 transition-all disabled:opacity-50"
        >
            {children}
        </button>
    );
}

// ─── OCR Auto-fill Modal ────────────────────────────────────────────────────

export function OCRModal({ open, onClose, onResult }: {
    open: boolean;
    onClose: () => void;
    onResult: (data: any) => void;
}) {
    const [aadhaarFront, setAadhaarFront] = useState<File | null>(null);
    const [aadhaarBack, setAadhaarBack] = useState<File | null>(null);
    const [scanning, setScanning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [scanStatus, setScanStatus] = useState<string>('');

    if (!open) return null;

    const handleScan = async () => {
        if (!aadhaarFront || !aadhaarBack) {
            setError('Please upload both Aadhaar front and back');
            return;
        }

        setScanning(true);
        setError(null);
        setScanStatus('Connecting to OCR service...');

        try {
            const formData = new FormData();
            formData.append('aadhaarFront', aadhaarFront);
            formData.append('aadhaarBack', aadhaarBack);

            setScanStatus('Extracting details from Aadhaar...');

            const res = await fetch('/api/leads/autofillRequest', {
                method: 'POST',
                body: formData,
            });
            const data = await res.json();

            if (data.success) {
                onResult(data.data);
                onClose();
            } else {
                setError(data.error?.message || 'Could not read document. Please ensure image is clear');
            }
        } catch {
            setError('Scanning failed. Please try again.');
        } finally {
            setScanning(false);
            setScanStatus('');
        }
    };

    const handleClose = () => {
        setAadhaarFront(null);
        setAadhaarBack(null);
        setError(null);
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full mx-4 p-8">
                <div className="flex justify-between items-start mb-2">
                    <div>
                        <h3 className="text-xl font-black text-gray-900">Auto-fill Customer Details</h3>
                        <p className="text-sm text-gray-500 mt-1">
                            Upload Aadhaar to extract name, DOB, and address instantly.
                        </p>
                    </div>
                    <button onClick={handleClose} className="p-1 hover:bg-gray-100 rounded-lg">
                        <X className="w-5 h-5 text-gray-400" />
                    </button>
                </div>

                <div className="grid grid-cols-2 gap-4 mt-6">
                    <UploadBox
                        label="Aadhaar Front"
                        file={aadhaarFront}
                        onSelect={setAadhaarFront}
                        scanning={scanning}
                    />
                    <UploadBox
                        label="Aadhaar Back"
                        file={aadhaarBack}
                        onSelect={setAadhaarBack}
                        scanning={scanning}
                    />
                </div>

                {scanning && (
                    <div className="mt-4 flex flex-col items-center gap-2">
                        <div className="flex items-center gap-2 text-sm text-[#0047AB] font-medium">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            {scanStatus || 'Processing...'}
                        </div>
                        <p className="text-xs text-gray-400">This may take up to 30 seconds</p>
                    </div>
                )}

                {error && (
                    <p className="mt-4 text-sm text-red-600 font-medium">{error}</p>
                )}

                <div className="mt-6 space-y-3">
                    <button
                        onClick={handleScan}
                        disabled={!aadhaarFront || !aadhaarBack || scanning}
                        className="w-full py-3 bg-[#0047AB] text-white rounded-xl font-bold text-sm hover:bg-[#003580] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scan className="w-4 h-4" />}
                        Start Scanning
                    </button>
                    <button
                        onClick={handleClose}
                        disabled={scanning}
                        className="w-full py-3 border-2 border-[#EBEBEB] rounded-xl font-bold text-sm text-gray-700 hover:bg-gray-50 transition-all"
                    >
                        Cancel
                    </button>
                </div>

                <p className="text-xs text-gray-400 mt-4">
                    *Upload Aadhaar will be removed from system after data extraction
                </p>
            </div>
        </div>
    );
}

function UploadBox({ label, file, onSelect, scanning }: {
    label: string;
    file: File | null;
    onSelect: (f: File) => void;
    scanning: boolean;
}) {
    return (
        <label className={`flex flex-col items-center justify-center p-6 border-2 border-dashed rounded-2xl cursor-pointer transition-all min-h-[120px] ${
            file ? 'border-[#0047AB] bg-blue-50' : 'border-gray-200 hover:border-[#0047AB] hover:bg-gray-50'
        } ${scanning ? 'opacity-50 pointer-events-none' : ''}`}>
            <input
                type="file"
                className="hidden"
                accept="image/png,image/jpeg,image/jpg,application/pdf"
                onChange={e => e.target.files?.[0] && onSelect(e.target.files[0])}
            />
            {file ? (
                <CheckCircle2 className="w-8 h-8 text-[#0047AB] mb-2" />
            ) : (
                <Upload className="w-8 h-8 text-gray-300 mb-2" />
            )}
            <span className="text-sm font-bold text-gray-700">{label}</span>
            <span className="text-xs text-gray-400 mt-1">
                {file ? file.name.slice(0, 20) : 'Click to upload'}
            </span>
        </label>
    );
}

// ─── Full Page Loader ───────────────────────────────────────────────────────

export function FullPageLoader() {
    return (
        <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB]">
            <Loader2 className="w-10 h-10 animate-spin text-[#1D4ED8]" />
        </div>
    );
}
