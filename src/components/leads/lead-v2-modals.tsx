'use client';

import { useState, useEffect } from 'react';
import { X, UploadCloud, Loader2, AlertCircle, CheckCircle2, Info, Scan } from 'lucide-react';

// --- Base Modal Component ---
export function Modal({ isOpen, onClose, title, children, size = 'md' }: any) {
    if (!isOpen) return null;

    const sizes: any = {
        sm: 'max-w-md',
        md: 'max-w-xl',
        lg: 'max-w-3xl',
        xl: 'max-w-5xl'
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className={`bg-white rounded-2xl shadow-2xl w-full ${sizes[size]} overflow-hidden flex flex-col max-h-[90vh]`}>
                <div className="flex items-center justify-between px-6 py-4 border-b">
                    <h3 className="text-xl font-semibold text-gray-900">{title}</h3>
                    <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full transition-colors text-gray-500">
                        <X className="w-5 h-5" />
                    </button>
                </div>
                <div className="p-6 overflow-y-auto flex-1">
                    {children}
                </div>
            </div>
        </div>
    );
}

// --- Help Modal ---
export function HelpModal({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) {
    const [content, setContent] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (isOpen) {
            fetch('/api/help/lead-step-1')
                .then(res => res.json())
                .then(data => {
                    setContent(data.data);
                    setLoading(false);
                });
        }
    }, [isOpen]);

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={content?.title || "Lead Creation Help"}>
            {loading ? (
                <div className="flex justify-center p-8"><Loader2 className="w-8 h-8 animate-spin text-brand-600" /></div>
            ) : (
                <div className="space-y-6">
                    {content?.sections.map((s: any, i: number) => (
                        <div key={i} className="space-y-2">
                            <h4 className="font-bold text-gray-800">{s.subtitle}</h4>
                            <p className="text-gray-600 text-sm leading-relaxed">{s.content}</p>
                        </div>
                    ))}
                    <div className="p-4 bg-blue-50 border border-blue-100 rounded-xl mt-4">
                        <p className="text-xs text-blue-700 font-medium">
                            Disclaimer: Data processed for KYC purposes. Aadhaar masking applied on view.
                        </p>
                    </div>
                </div>
            )}
        </Modal>
    );
}

// --- Auto-fill / OCR Modal ---
export function AutofillModal({ isOpen, onClose, onAutofill, leadId, ensureLead }: any) {
    const [frontFile, setFrontFile] = useState<File | null>(null);
    const [backFile, setBackFile] = useState<File | null>(null);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [partialFields, setPartialFields] = useState<string[]>([]);
    const [progress, setProgress] = useState(0);
    const [statusMessage, setStatusMessage] = useState<string | null>(null);
    const [frontUploaded, setFrontUploaded] = useState(false);
    const [backUploaded, setBackUploaded] = useState(false);

    const isOnline = () => typeof navigator !== 'undefined' ? navigator.onLine : true;

    const fetchWithRetry = async (url: string, options: any, retries = 3) => {
        let lastError;
        for (let i = 0; i < retries; i++) {
            if (!isOnline()) throw new Error("Connection lost. Please check your internet and retry.");
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 30000);
                const res = await fetch(url, { ...options, credentials: 'include', signal: controller.signal });
                clearTimeout(timeout);
                const data = await res.json();
                if (res.ok && data.success) return data;

                lastError = data.error?.message || data.message || "Request failed";
                if (res.status < 500 && res.status !== 408) throw new Error(lastError);
            } catch (e: any) {
                if (e.name === 'AbortError') {
                    lastError = "Request timed out. Please try again.";
                } else if (e.message?.includes('Failed to fetch') || e.message?.includes('NetworkError') || e.message?.includes('Load failed')) {
                    lastError = "Connection lost. Please check your internet and retry.";
                } else {
                    lastError = e.message;
                }
                if (i === retries - 1) throw new Error(lastError);
                await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
            }
        }
    };

    // File selection handlers with confirmation
    const handleFrontFile = (file: File | null) => {
        setFrontFile(file);
        setFrontUploaded(false);
        if (file) setStatusMessage(`Front image selected: ${file.name}`);
    };

    const handleBackFile = (file: File | null) => {
        setBackFile(file);
        setBackUploaded(false);
        if (file) setStatusMessage(`Back image selected: ${file.name}`);
    };

    const handleUpload = async () => {
        if (!frontFile || !backFile) {
            setError("Both front and back images are required");
            return;
        }

        if (!isOnline()) {
            setError("Connection lost. Please check your internet and retry.");
            return;
        }

        setUploading(true);
        setError(null);
        setPartialFields([]);
        setProgress(5);
        setStatusMessage("Initializing...");

        try {
            // 0. Ensure Lead exists
            let currentLeadId = leadId;
            if (!currentLeadId) {
                setProgress(10);
                currentLeadId = await ensureLead();
                if (!currentLeadId) throw new Error("Could not initialize lead draft");
            }
            setProgress(20);
            setStatusMessage("Uploading front image...");

            // 1. Upload Front
            const frontFormData = new FormData();
            frontFormData.append('file', frontFile);
            frontFormData.append('documentType', 'Aadhaar Front');
            frontFormData.append('leadId', currentLeadId);

            const frontData = await fetchWithRetry('/api/documents/upload', { method: 'POST', body: frontFormData });
            setProgress(40);
            setFrontUploaded(true);
            setStatusMessage("Front image uploaded. Uploading back image...");

            // 2. Upload Back
            const backFormData = new FormData();
            backFormData.append('file', backFile);
            backFormData.append('documentType', 'Aadhaar Back');
            backFormData.append('leadId', currentLeadId);

            const backData = await fetchWithRetry('/api/documents/upload', { method: 'POST', body: backFormData });
            setProgress(60);
            setBackUploaded(true);
            setStatusMessage("Both images uploaded. Running OCR extraction...");

            // 3. Initiate OCR
            const ocrData = await fetchWithRetry('/api/leads/autofillRequest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    idType: 'aadhaar',
                    leadId: currentLeadId,
                    frontId: frontData.data.documentId,
                    backId: backData.data.documentId
                })
            });

            setProgress(100);

            if (ocrData.data.ocrStatus === 'partial') {
                setPartialFields(ocrData.data.missingFields || []);
                setError(`Partial detection: ${ocrData.data.missingFields?.join(', ')} not found.`);
                setStatusMessage("OCR completed with partial results.");
                onAutofill(ocrData.data);
            } else if (ocrData.data.ocrStatus === 'failed') {
                setError(ocrData.data.ocrError || "Scanning failed. No fields detected.");
                setStatusMessage(null);
                onAutofill({ ...ocrData.data, auto_filled: false });
            } else {
                setStatusMessage("OCR completed successfully!");
                onAutofill(ocrData.data);
                setTimeout(() => onClose(), 500);
            }

        } catch (err: any) {
            const msg = err.message || "Failed to process documents after retries";
            setError(msg);
            setProgress(0);
            setStatusMessage(null);
            onAutofill({
                ocr_status: 'failed',
                ocr_error: msg,
                auto_filled: false
            });
        } finally {
            setUploading(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Auto-fill Customer Details">
            <div className="space-y-6">
                <div className="p-4 bg-amber-50 border border-amber-100 rounded-xl flex items-start gap-3">
                    <Info className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                        <p className="text-xs text-amber-800 font-bold">Scanning Instructions</p>
                        <p className="text-[10px] text-amber-700 mt-0.5">
                            Upload clear, un-cropped images of Aadhaar card. Manual entry is always available as fallback.
                        </p>
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                    <FileUploadSlot label="Aadhaar Front" file={frontFile} setFile={handleFrontFile} disabled={uploading} uploaded={frontUploaded} />
                    <FileUploadSlot label="Aadhaar Back" file={backFile} setFile={handleBackFile} disabled={uploading} uploaded={backUploaded} />
                </div>

                {/* Status / confirmation message */}
                {statusMessage && (
                    <div className="p-3 bg-blue-50 border border-blue-100 rounded-xl flex items-center gap-2 text-sm text-blue-700 animate-in fade-in">
                        {uploading ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> : <CheckCircle2 className="w-4 h-4 shrink-0 text-green-500" />}
                        <span className="text-xs font-medium">{statusMessage}</span>
                    </div>
                )}

                {uploading && (
                    <div className="space-y-2 animate-in fade-in">
                        <div className="flex justify-between text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                            <span>Processing Documents</span>
                            <span>{progress}%</span>
                        </div>
                        <div className="w-full bg-gray-100 h-1.5 rounded-full overflow-hidden">
                            <div className="bg-brand-600 h-full transition-all duration-700 ease-in-out shadow-[0_0_8px_rgba(37,99,235,0.4)]" style={{ width: `${progress}%` }} />
                        </div>
                    </div>
                )}

                {error && (
                    <div className={`p-3 border rounded-xl flex items-start gap-2 text-sm ${partialFields.length > 0 ? 'bg-amber-50 border-amber-100 text-amber-700' : 'bg-red-50 border-red-100 text-red-700'}`}>
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <div>
                            <p className="font-bold">{partialFields.length > 0 ? "Partial Extraction" : "Scan Error"}</p>
                            <p className="text-xs">{error}</p>
                            {partialFields.length > 0 && <p className="text-[10px] mt-1 italic">Manual entry enabled for missing fields.</p>}
                        </div>
                    </div>
                )}

                <div className="flex gap-3 pt-4">
                    <button
                        onClick={onClose}
                        disabled={uploading}
                        className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl font-bold text-gray-500 hover:bg-gray-50 transition-colors disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleUpload}
                        disabled={uploading || !frontFile || !backFile}
                        className="flex-1 px-4 py-2.5 bg-brand-600 text-white rounded-xl font-bold hover:bg-brand-700 shadow-lg shadow-brand-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                    >
                        {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scan className="w-4 h-4" />}
                        {error && !uploading ? "Retry Scan" : "Start Scanning"}
                    </button>
                </div>

                {partialFields.length > 0 && !uploading && (
                    <button onClick={onClose} className="w-full text-center text-xs text-brand-600 font-bold hover:underline">
                        Continue with Manual Entry
                    </button>
                )}
            </div>
        </Modal>
    );
}

function FileUploadSlot({ label, file, setFile, disabled, uploaded }: any) {
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-700 uppercase tracking-wider">{label}</span>
                {file && uploaded && (
                    <span className="text-[10px] font-bold text-green-600 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> Uploaded
                    </span>
                )}
                {file && !uploaded && (
                    <span className="text-[10px] font-bold text-blue-600">Selected</span>
                )}
            </div>
            <label className={`
                h-40 border-2 border-dashed rounded-xl flex flex-col items-center justify-center p-4 cursor-pointer transition-all
                ${file && uploaded ? 'border-green-400 bg-green-50' : file ? 'border-blue-300 bg-blue-50' : 'border-gray-200 bg-gray-50 hover:bg-white hover:border-brand-300'}
                ${disabled ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''}
            `}>
                {file ? (
                    <div className="flex flex-col items-center text-center">
                        <CheckCircle2 className={`w-8 h-8 mb-2 ${uploaded ? 'text-green-500' : 'text-blue-500'}`} />
                        <span className="text-xs font-medium text-gray-700 truncate max-w-full px-2">{file.name}</span>
                        <span className="text-[10px] text-gray-400 mt-1">{uploaded ? 'Uploaded successfully' : 'Click to change'}</span>
                    </div>
                ) : (
                    <div className="flex flex-col items-center text-center">
                        <UploadCloud className="w-8 h-8 text-gray-400 mb-2" />
                        <span className="text-sm font-medium text-gray-600">Click to upload</span>
                        <span className="text-[10px] text-gray-400 mt-1">PNG, JPG, PDF (Max 5MB)</span>
                    </div>
                )}
                <input type="file" className="hidden" accept="image/*,.pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} disabled={disabled} />
            </label>
        </div>
    );
}

// --- Duplicate Warning Modal ---
export function DuplicateModal({ isOpen, onClose, matches, onContinue }: any) {
    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Duplicate Lead Warning">
            <div className="space-y-6">
                <div className="p-4 bg-red-50 border border-red-100 rounded-xl flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                    <div>
                        <p className="text-sm font-bold text-red-800">Existing Lead(s) Found</p>
                        <p className="text-xs text-red-700 mt-1">
                            A lead with this phone number already exists in your dealership. For privacy, we only show matches from your own dealership.
                        </p>
                    </div>
                </div>

                <div className="space-y-3">
                    {matches.map((m: any) => (
                        <div key={m.id} className="p-4 border rounded-xl flex items-center justify-between hover:bg-gray-50 transition-colors">
                            <div>
                                <p className="font-bold text-gray-900">{m.referenceId}</p>
                                <p className="text-xs text-gray-500">Created: {new Date(m.created_at).toLocaleDateString()}</p>
                            </div>
                            <div className="flex items-center gap-3">
                                <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase ${m.status === 'INCOMPLETE' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'
                                    }`}>
                                    {m.status}
                                </span>
                                <button className="text-brand-600 text-sm font-bold hover:underline">View</button>
                            </div>
                        </div>
                    ))}
                </div>

                <div className="flex gap-3 pt-2">
                    <button
                        onClick={onClose}
                        className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                        Go Back
                    </button>
                    <button
                        onClick={() => {
                            onContinue();
                            onClose();
                        }}
                        className="flex-1 px-4 py-2.5 bg-brand-600 text-white rounded-xl font-medium hover:bg-brand-700 shadow-lg shadow-brand-500/30 transition-all"
                    >
                        Proceed Anyway
                    </button>
                </div>
            </div>
        </Modal>
    );
}
