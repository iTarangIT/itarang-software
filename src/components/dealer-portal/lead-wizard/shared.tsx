'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
    ChevronLeft, ChevronDown, Loader2, AlertCircle, X,
    Upload, CheckCircle2, XCircle, Clock, Scan, Eye, FileText,
    ShieldCheck
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

export function InputField({ label, value, onChange, onBlur, error, placeholder, required, type = 'text', disabled, className, inputMode, maxLength }: {
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
    inputMode?: 'text' | 'numeric' | 'tel' | 'email' | 'url' | 'search' | 'decimal' | 'none';
    maxLength?: number;
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
                inputMode={inputMode}
                maxLength={maxLength}
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
    const isPdf = !!fileUrl && /\.pdf($|\?)/i.test(fileUrl);
    const isImage = !!fileUrl && !isPdf;
    const isVerified = dealerStatus.icon === 'check';
    const isRejected = dealerStatus.icon === 'reupload' || dealerStatus.icon === 'error';
    const isPending = uploaded && !isVerified && !isRejected;

    const border = !uploaded
        ? 'border-dashed border-gray-200 hover:border-[#0047AB]/60'
        : isVerified
            ? 'border-emerald-200 hover:border-emerald-400'
            : isRejected
                ? 'border-red-200 hover:border-red-400'
                : 'border-amber-200 hover:border-amber-400';

    const pill = !uploaded
        ? { bg: 'bg-gray-100', text: 'text-gray-500', label: required ? 'Required' : 'Optional' }
        : isVerified
            ? { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'Verified' }
            : isRejected
                ? { bg: 'bg-red-50', text: 'text-red-700', label: 'Re-upload' }
                : { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Pending' };

    return (
        <div className={`group relative rounded-2xl border-2 bg-white transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5 overflow-hidden ${border} ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
            <label className={`block ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                <input
                    type="file"
                    className="hidden"
                    accept="image/png,image/jpeg,image/jpg,application/pdf"
                    disabled={disabled}
                    onChange={e => e.target.files?.[0] && onUpload(e.target.files[0])}
                />

                {/* Preview area */}
                <div className="relative aspect-[4/3] bg-gradient-to-br from-gray-50 to-gray-100">
                    {isImage && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={fileUrl!} alt={label} className="w-full h-full object-cover" />
                    )}
                    {isPdf && (
                        <div className="w-full h-full flex flex-col items-center justify-center">
                            <div className="w-14 h-16 bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col items-center justify-center">
                                <FileText className="w-6 h-6 text-red-400" strokeWidth={2.2} />
                                <span className="text-[8px] font-black text-red-500 tracking-wider mt-0.5">PDF</span>
                            </div>
                        </div>
                    )}
                    {!uploaded && (
                        <div className="w-full h-full flex flex-col items-center justify-center">
                            <div className="w-12 h-12 rounded-full bg-white shadow-sm border border-gray-200 flex items-center justify-center mb-2 group-hover:border-[#0047AB]/40 transition-colors">
                                <Upload className="w-5 h-5 text-gray-400 group-hover:text-[#0047AB] transition-colors" />
                            </div>
                            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 group-hover:text-[#0047AB] transition-colors">Tap to Upload</span>
                        </div>
                    )}

                    {/* Status dot — top right */}
                    <span className={`absolute top-2.5 right-2.5 w-3 h-3 rounded-full ring-2 ring-white shadow-sm ${dealerStatus.dotColor}`} />

                    {/* Required badge — top left (only when not uploaded) */}
                    {!uploaded && required && (
                        <span className="absolute top-2.5 left-2.5 px-1.5 py-0.5 rounded-md bg-red-500 text-white text-[9px] font-black uppercase tracking-wide shadow-sm">Required</span>
                    )}

                    {/* Hover overlay (only when uploaded) */}
                    {uploaded && (
                        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-end justify-center pb-3 gap-2">
                            {fileUrl && (
                                <a
                                    href={fileUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={e => e.stopPropagation()}
                                    className="px-3 py-1.5 bg-white/95 backdrop-blur rounded-lg text-[11px] font-bold text-gray-900 flex items-center gap-1.5 hover:bg-white shadow-md"
                                >
                                    <Eye className="w-3.5 h-3.5" /> View
                                </a>
                            )}
                            <span className="px-3 py-1.5 bg-[#0047AB] rounded-lg text-[11px] font-bold text-white flex items-center gap-1.5 shadow-md">
                                <Upload className="w-3.5 h-3.5" /> Re-upload
                            </span>
                        </div>
                    )}
                </div>

                {/* Label + status pill */}
                <div className="px-3 py-3 border-t border-gray-100">
                    <p className="text-xs font-bold text-gray-900 truncate leading-tight">{label}</p>
                    <div className="flex items-center gap-1.5 mt-1.5">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${pill.bg} ${pill.text}`}>
                            {isVerified && <CheckCircle2 className="w-2.5 h-2.5" />}
                            {isRejected && <XCircle className="w-2.5 h-2.5" />}
                            {isPending && <Clock className="w-2.5 h-2.5" />}
                            {pill.label}
                        </span>
                    </div>
                    {failedReason && (
                        <p className="text-[10px] text-red-500 mt-1.5 leading-snug line-clamp-2">{failedReason}</p>
                    )}
                </div>
            </label>
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

// ─── DigiLocker KYC Button ─────────────────────────────────────────────────
//
// Opens the Decentro DigiLocker SSO URL in a popup. The driver signs into
// DigiLocker on the popup, authorises iTarang, and submits. Our callback
// route fetches eAadhaar and postMessages the normalized fields back into
// this window. Same onResult signature as OCRModal so the caller wires
// both buttons to a single handleOCRResult.

type DigilockerStatus = 'idle' | 'initiating' | 'awaiting' | 'success' | 'failed';

export function DigilockerKycButton({ leadId, phone, onResult, disabled }: {
    leadId: string | null;
    phone?: string;
    onResult: (data: Record<string, unknown>) => void;
    disabled?: boolean;
}) {
    const [status, setStatus] = useState<DigilockerStatus>('idle');
    const [error, setError] = useState<string | null>(null);
    const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
    const popupRef = useRef<Window | null>(null);
    const txnIdRef = useRef<string | null>(null);
    const handlerRef = useRef<((e: MessageEvent) => void) | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const cleanup = () => {
        if (handlerRef.current) {
            window.removeEventListener('message', handlerRef.current);
            handlerRef.current = null;
        }
        if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
        popupRef.current = null;
        txnIdRef.current = null;
    };

    useEffect(() => () => cleanup(), []);

    const openPopup = (url: string): Window | null => {
        const features = 'width=520,height=720,menubar=no,toolbar=no,location=yes,status=yes,resizable=yes,scrollbars=yes';
        return window.open(url, 'itarang-digilocker', features);
    };

    const handleClick = async () => {
        if (disabled || status === 'initiating' || status === 'awaiting') return;
        if (!leadId) {
            setError('Please wait for the draft to initialize.');
            setStatus('failed');
            return;
        }

        setError(null);
        setFallbackUrl(null);
        setStatus('initiating');

        try {
            const res = await fetch('/api/leads/digilocker/initiate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ leadId, phone: phone || undefined }),
            });
            const json = await res.json();
            if (!json.success) {
                setError(json.error?.message || 'Failed to start DigiLocker session');
                setStatus('failed');
                return;
            }

            const { transactionId, authorizationUrl } = json.data as {
                transactionId: string;
                authorizationUrl: string;
            };
            txnIdRef.current = transactionId;

            // Register listener BEFORE opening the popup so we never miss
            // a fast postMessage. Listener removes itself after handling.
            const handler = (e: MessageEvent) => {
                if (e.origin !== window.location.origin) return;
                const data = e.data;
                if (!data || typeof data !== 'object') return;
                if (data.type !== 'itarang:digilocker') return;
                if (data.transactionId !== txnIdRef.current) return;

                if (data.ok && data.data) {
                    onResult(data.data);
                    setStatus('success');
                } else {
                    setError(data.error || 'DigiLocker authorization failed');
                    setStatus('failed');
                }
                cleanup();
            };
            handlerRef.current = handler;
            window.addEventListener('message', handler);

            const popup = openPopup(authorizationUrl);
            popupRef.current = popup;

            if (!popup) {
                // Popup blocker kicked in — keep the listener, surface
                // a fallback link the user can click (preserves the
                // user-gesture requirement for most browsers).
                setFallbackUrl(authorizationUrl);
                setStatus('awaiting');
                return;
            }

            setStatus('awaiting');

            // Detect user-closed popup without authorising. Poll the
            // popup.closed flag; if it closes before success, reset.
            pollRef.current = setInterval(() => {
                if (popupRef.current && popupRef.current.closed) {
                    if (pollRef.current) clearInterval(pollRef.current);
                    pollRef.current = null;
                    // Give any late postMessage ~1s to arrive before
                    // giving up — the close event can race the message.
                    setTimeout(() => {
                        setStatus(prev => {
                            if (prev === 'awaiting') {
                                setError('DigiLocker window was closed before authorization completed.');
                                cleanup();
                                return 'failed';
                            }
                            return prev;
                        });
                    }, 1200);
                }
            }, 800);
        } catch {
            setError('Network error. Please try again.');
            setStatus('failed');
        }
    };

    const label =
        status === 'initiating' ? 'Starting...'
        : status === 'awaiting' ? 'Waiting for authorization...'
        : status === 'success' ? 'Aadhaar KYC ✓'
        : 'Aadhaar KYC';

    return (
        <div className="flex items-center gap-2">
            <button
                type="button"
                onClick={handleClick}
                disabled={disabled || status === 'initiating' || status === 'awaiting'}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-sm shadow-sm transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                    status === 'success'
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : status === 'failed'
                            ? 'bg-red-50 text-red-700 border border-red-200 hover:bg-red-100'
                            : 'bg-white border border-gray-200 text-gray-800 hover:border-[#1D4ED8] hover:text-[#1D4ED8]'
                }`}
            >
                {status === 'initiating' || status === 'awaiting'
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : status === 'success'
                        ? <CheckCircle2 className="w-4 h-4" />
                        : <ShieldCheck className="w-4 h-4" />}
                {label}
            </button>
            {fallbackUrl && status === 'awaiting' && (
                <a
                    href={fallbackUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-semibold text-[#1D4ED8] underline"
                >
                    Popup blocked — open link
                </a>
            )}
            {error && status === 'failed' && (
                <span className="text-xs text-red-600 max-w-[280px] truncate" title={error}>{error}</span>
            )}
        </div>
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
