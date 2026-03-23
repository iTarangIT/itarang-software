'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { Upload, CheckCircle2, AlertCircle, Loader2, FileText } from 'lucide-react';

export default function PublicUploadPage() {
    const params = useParams();
    const leadId = params.leadId as string;
    const requestId = params.requestId as string;
    const token = params.token as string;

    const [loading, setLoading] = useState(true);
    const [docLabel, setDocLabel] = useState('');
    const [alreadyUploaded, setAlreadyUploaded] = useState(false);
    const [expired, setExpired] = useState(false);
    const [invalid, setInvalid] = useState(false);

    const [file, setFile] = useState<File | null>(null);
    const [uploading, setUploading] = useState(false);
    const [uploaded, setUploaded] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const verify = async () => {
            try {
                const res = await fetch(`/api/public/upload-docs/${leadId}/${requestId}/${token}`);
                const data = await res.json();
                if (res.status === 404 || res.status === 403) { setInvalid(true); return; }
                if (res.status === 410) { setExpired(true); return; }
                if (data.success) {
                    setDocLabel(data.data.doc_label);
                    setAlreadyUploaded(data.data.already_uploaded);
                }
            } catch { setInvalid(true); }
            finally { setLoading(false); }
        };
        verify();
    }, [leadId, requestId, token]);

    const handleUpload = async () => {
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) { setError('File must be under 5MB'); return; }
        setUploading(true); setError(null);
        try {
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch(`/api/public/upload-docs/${leadId}/${requestId}/${token}`, {
                method: 'POST', body: formData,
            });
            const data = await res.json();
            if (data.success) { setUploaded(true); }
            else { setError(data.error?.message || 'Upload failed'); }
        } catch { setError('Upload failed. Please try again.'); }
        finally { setUploading(false); }
    };

    if (loading) return (
        <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB]">
            <Loader2 className="w-10 h-10 animate-spin text-[#1D4ED8]" />
        </div>
    );

    if (invalid) return (
        <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB]">
            <div className="text-center max-w-sm px-6">
                <AlertCircle className="w-16 h-16 text-red-400 mx-auto mb-4" />
                <h2 className="text-xl font-bold text-gray-900">Invalid Link</h2>
                <p className="text-sm text-gray-500 mt-2">This upload link is invalid. Please contact your dealer or Itarang team for a new link.</p>
            </div>
        </div>
    );

    if (expired) return (
        <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB]">
            <div className="text-center max-w-sm px-6">
                <AlertCircle className="w-16 h-16 text-amber-400 mx-auto mb-4" />
                <h2 className="text-xl font-bold text-gray-900">Link Expired</h2>
                <p className="text-sm text-gray-500 mt-2">This upload link has expired. Please contact your dealer or the Itarang team for a new link.</p>
            </div>
        </div>
    );

    if (uploaded || alreadyUploaded) return (
        <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB]">
            <div className="text-center max-w-sm px-6">
                <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
                <h2 className="text-xl font-bold text-gray-900">Document Uploaded</h2>
                <p className="text-sm text-gray-500 mt-2">
                    {alreadyUploaded && !uploaded
                        ? 'You have already uploaded this document.'
                        : 'Your document has been submitted successfully. The Itarang team will review it shortly.'}
                </p>
                <p className="text-xs text-gray-400 mt-4">You may close this page.</p>
            </div>
        </div>
    );

    return (
        <div className="min-h-screen bg-[#F8F9FB] flex items-center justify-center px-4">
            <div className="w-full max-w-md">
                {/* Branding */}
                <div className="text-center mb-8">
                    <div className="w-16 h-16 bg-[#0047AB] rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <FileText className="w-8 h-8 text-white" />
                    </div>
                    <h1 className="text-2xl font-black text-gray-900">Document Upload</h1>
                    <p className="text-sm text-gray-500 mt-1">Requested by Itarang Finance Team</p>
                </div>

                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
                    {/* Requested doc info */}
                    <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-xl">
                        <p className="text-xs font-bold text-blue-500 uppercase tracking-wider mb-1">Document Requested</p>
                        <p className="text-base font-black text-blue-900">{docLabel}</p>
                    </div>

                    {/* File picker */}
                    <div className="mb-4">
                        <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Select File</label>
                        <label className={`flex flex-col items-center justify-center w-full h-36 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${file ? 'border-[#0047AB] bg-blue-50' : 'border-gray-200 bg-gray-50 hover:border-gray-300'}`}>
                            <input type="file" className="hidden" accept="image/jpeg,image/png,application/pdf"
                                onChange={e => { setFile(e.target.files?.[0] || null); setError(null); }} />
                            {file ? (
                                <div className="text-center">
                                    <CheckCircle2 className="w-8 h-8 text-[#0047AB] mx-auto mb-2" />
                                    <p className="text-sm font-bold text-[#0047AB]">{file.name}</p>
                                    <p className="text-xs text-blue-400">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                                </div>
                            ) : (
                                <div className="text-center">
                                    <Upload className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                                    <p className="text-sm text-gray-400">Tap to select a file</p>
                                    <p className="text-xs text-gray-300 mt-1">JPG, PNG, or PDF — max 5MB</p>
                                </div>
                            )}
                        </label>
                    </div>

                    {error && (
                        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl flex items-center gap-2 text-sm text-red-700">
                            <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
                        </div>
                    )}

                    <button onClick={handleUpload} disabled={!file || uploading}
                        className="w-full py-3.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] disabled:opacity-50 flex items-center justify-center gap-2 transition-colors">
                        {uploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
                        {uploading ? 'Uploading...' : 'Submit Document'}
                    </button>
                </div>

                <p className="text-xs text-gray-400 text-center mt-4">Your document is encrypted and securely stored by iTarang Finance.</p>
            </div>
        </div>
    );
}
