'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AlertCircle, RefreshCw, ArrowLeft } from 'lucide-react';

export default function BorrowerConsentErrorBoundary({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    const router = useRouter();
    const params = useParams();
    const leadId = (params?.id as string) || '';

    useEffect(() => {
        console.error('[Borrower Consent Page] Render error:', error);
    }, [error]);

    return (
        <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB] p-6">
            <div className="max-w-md w-full bg-white border border-gray-100 rounded-2xl shadow-sm p-8 text-center space-y-5">
                <div className="w-14 h-14 mx-auto rounded-full bg-red-50 flex items-center justify-center">
                    <AlertCircle className="w-7 h-7 text-red-500" />
                </div>
                <div>
                    <h2 className="text-xl font-bold text-gray-900">Something went wrong</h2>
                    <p className="text-sm text-gray-500 mt-1">
                        The borrower consent page couldn&apos;t load. Please try again, or return to lead creation.
                    </p>
                    {error?.digest && (
                        <p className="text-[11px] text-gray-400 mt-2 font-mono">Ref: {error.digest}</p>
                    )}
                </div>
                <div className="flex gap-3">
                    <button
                        onClick={reset}
                        className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] transition-all"
                    >
                        <RefreshCw className="w-4 h-4" /> Retry
                    </button>
                    <button
                        onClick={() => router.push('/dealer-portal/leads/new')}
                        className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm font-bold text-gray-700 hover:bg-gray-50 transition-all"
                    >
                        <ArrowLeft className="w-4 h-4" /> Lead Creation
                    </button>
                </div>
                {leadId && (
                    <p className="text-[11px] text-gray-400 font-mono pt-2 border-t border-gray-100">Lead: {leadId}</p>
                )}
            </div>
        </div>
    );
}
