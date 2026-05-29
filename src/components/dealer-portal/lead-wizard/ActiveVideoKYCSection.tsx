'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    AlertCircle, CheckCircle2, Clock, Copy, Loader2, MessageSquare, RefreshCw, Send, Video,
} from 'lucide-react';
import { SectionCard, PrimaryButton, SecondaryButton } from './shared';

type StatusState =
    | 'loading'
    | 'not_initiated'
    | 'awaiting_customer'
    | 'admin_review_pending'
    | 'success'
    | 'verified'
    | 'failed'
    | 'rejected';

interface SmsInfo {
    attempts?: number;
    status?: 'delivered' | 'failed' | 'skipped' | string;
    error?: string | null;
    sent_at?: string;
}

interface StatusPayload {
    state: StatusState;
    status: string | null;
    last_update: string | null;
    failed_reason: string | null;
    sms: SmsInfo | null;
    results: Record<string, unknown> | null;
    bestMatchScore: number | null;
    videoLivenessUrl: string | null;
    decentroTxnId?: string;
    adminAction?: string | null;
    callback_received_at?: string | null;
}

interface ActiveVideoKYCSectionProps {
    leadId: string;
    customerName?: string;
    customerPhone?: string;
}

function statusBadge(state: StatusState | null) {
    if (state === 'verified' || state === 'success') {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold"><CheckCircle2 className="w-3 h-3" />Verified</span>;
    }
    if (state === 'admin_review_pending') {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-bold"><Clock className="w-3 h-3" />Awaiting Admin Review</span>;
    }
    if (state === 'awaiting_customer') {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-bold"><Send className="w-3 h-3" />Link Sent</span>;
    }
    if (state === 'failed' || state === 'rejected') {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-red-100 text-red-700 rounded-full text-xs font-bold"><AlertCircle className="w-3 h-3" />Failed</span>;
    }
    return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-gray-100 text-gray-600 rounded-full text-xs font-bold">Not Sent</span>;
}

function maskedPhone(p?: string): string {
    if (!p) return '—';
    const digits = p.replace(/\D/g, '').slice(-10);
    if (digits.length !== 10) return p;
    return `${digits.slice(0, 2)}XXXXXX${digits.slice(-2)}`;
}

export default function ActiveVideoKYCSection({
    leadId,
    customerName,
    customerPhone,
}: ActiveVideoKYCSectionProps) {
    const [data, setData] = useState<StatusPayload | null>(null);
    const [loading, setLoading] = useState(true);
    const [initiating, setInitiating] = useState(false);
    const [resending, setResending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const refresh = useCallback(async () => {
        try {
            const res = await fetch(`/api/kyc/${leadId}/decentro/active-video-liveness/status`, { cache: 'no-store' });
            const json = await res.json();
            if (json?.success && json.data) {
                setData(json.data as StatusPayload);
                setError(null);
            } else if (json?.error?.message) {
                setError(json.error.message);
            }
        } catch {
            // Silent — keep last good state
        } finally {
            setLoading(false);
        }
    }, [leadId]);

    useEffect(() => { refresh(); }, [refresh]);

    // Poll while a session is in-flight.
    useEffect(() => {
        const state = data?.state;
        const inflight = state === 'awaiting_customer' || state === 'admin_review_pending';
        if (!inflight) {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            return;
        }
        pollRef.current = setInterval(refresh, 6000);
        return () => {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        };
    }, [data?.state, refresh]);

    const handleInitiate = async () => {
        setInitiating(true);
        setError(null);
        try {
            const res = await fetch(`/api/kyc/${leadId}/decentro/active-video-liveness/initiate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const json = await res.json();
            if (!res.ok || !json?.success) {
                const missing = (json?.error?.missing as string[] | undefined)?.join(', ');
                throw new Error(
                    missing
                        ? `${json.error.message}: ${missing}`
                        : json?.error?.message || 'Could not start Video KYC',
                );
            }
            await refresh();
        } catch (e: any) {
            setError(e?.message || 'Could not start Video KYC');
        } finally {
            setInitiating(false);
        }
    };

    const handleResendSms = async () => {
        setResending(true);
        setError(null);
        try {
            const res = await fetch(`/api/kyc/${leadId}/decentro/active-video-liveness/resend-sms`, {
                method: 'POST',
            });
            const json = await res.json();
            if (!json?.success && !json?.data) {
                throw new Error(json?.error?.message || 'Resend SMS failed');
            }
            await refresh();
        } catch (e: any) {
            setError(e?.message || 'Could not resend SMS');
        } finally {
            setResending(false);
        }
    };

    const handleCopyLink = async () => {
        if (!data?.videoLivenessUrl) return;
        try {
            await navigator.clipboard.writeText(data.videoLivenessUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            setCopied(false);
        }
    };

    const state: StatusState | null = data?.state ?? null;
    const verified = state === 'verified' || state === 'success';
    const isAwaitingCustomer = state === 'awaiting_customer';
    const awaitingAdmin = state === 'admin_review_pending';
    const failedReason = data?.failed_reason || null;
    const sms = data?.sms || null;
    const phone = customerPhone || '';

    return (
        <SectionCard title="Video KYC (Customer)" action={loading ? null : statusBadge(state)}>
            <div className="space-y-5">
                {/* Why */}
                <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-900">
                    <p className="font-semibold mb-1">RBI-grade Video KYC</p>
                    <p className="text-blue-800/90 leading-relaxed">
                        We&apos;ll SMS a one-time secure link to
                        {customerName ? <> <span className="font-semibold">{customerName}</span></> : ' the customer'}
                        {' '}at <span className="font-semibold">{maskedPhone(phone)}</span>.
                        They open it on their phone and follow Decentro&apos;s prompts (blink, head turn, OTP utterance).
                        Verification matches their live video against their Aadhaar / passport photo.
                    </p>
                </div>

                {/* Verified */}
                {verified && (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-center gap-3">
                        <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                        <div className="text-sm text-emerald-800">
                            <p className="font-semibold">Video KYC verified by admin.</p>
                            {typeof data?.bestMatchScore === 'number' && (
                                <p className="text-xs text-emerald-700/80 mt-0.5">Best face-match score: {data.bestMatchScore.toFixed(1)}%</p>
                            )}
                        </div>
                    </div>
                )}

                {/* Awaiting admin */}
                {awaitingAdmin && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center gap-3">
                        <Clock className="w-5 h-5 text-amber-600 flex-shrink-0" />
                        <div className="text-sm text-amber-800">
                            <p className="font-semibold">Customer completed the session — awaiting admin review.</p>
                            <p className="text-xs text-amber-700/80 mt-0.5">Submit-for-Verification stays disabled until admin accepts.</p>
                        </div>
                    </div>
                )}

                {/* Failed */}
                {(state === 'failed' || state === 'rejected') && failedReason && (
                    <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
                        <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                        <div className="text-sm text-red-800">
                            <p className="font-semibold">Previous session was rejected</p>
                            <p className="text-xs text-red-700/90 mt-0.5">{failedReason}</p>
                        </div>
                    </div>
                )}

                {/* Awaiting customer */}
                {isAwaitingCustomer && (
                    <div className="space-y-3">
                        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
                            <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                                <p className="text-sm font-semibold text-blue-900">Waiting for the customer to complete the session</p>
                                {sms?.status === 'delivered' && (
                                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">
                                        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                                        SMS delivered{sms.attempts && sms.attempts > 1 ? ` · ${sms.attempts} attempts` : ''}
                                    </span>
                                )}
                                {sms?.status === 'failed' && (
                                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
                                        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                                        SMS failed{sms.error ? `: ${sms.error}` : ''}
                                    </span>
                                )}
                                {sms?.status === 'skipped' && (
                                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-gray-700 bg-gray-50 border border-gray-200 rounded-full px-2 py-0.5">
                                        <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                                        SMS not configured
                                    </span>
                                )}
                            </div>
                            <p className="text-xs text-blue-700/80">Auto-refreshing every 6s — this section updates as soon as the customer finishes.</p>
                        </div>

                        {data?.videoLivenessUrl && (
                            <div className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
                                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Session link</p>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="text"
                                        readOnly
                                        value={data.videoLivenessUrl}
                                        onClick={(e) => (e.target as HTMLInputElement).select()}
                                        className="flex-1 text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded px-2 py-1.5 truncate"
                                    />
                                    <button
                                        onClick={handleCopyLink}
                                        className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded transition-colors whitespace-nowrap inline-flex items-center gap-1"
                                    >
                                        <Copy className="w-3 h-3" />
                                        {copied ? 'Copied' : 'Copy'}
                                    </button>
                                </div>
                                <p className="text-[10px] text-gray-500">Share the link manually if the SMS didn&apos;t land. Decentro times the link out after ~24 hours.</p>
                            </div>
                        )}

                        <div className="flex gap-2 flex-wrap">
                            <button
                                onClick={handleResendSms}
                                disabled={resending}
                                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors inline-flex items-center gap-2"
                            >
                                {resending ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageSquare className="w-4 h-4" />}
                                {resending ? 'Resending…' : 'Resend SMS'}
                            </button>
                            <button
                                onClick={refresh}
                                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors inline-flex items-center gap-2"
                            >
                                <RefreshCw className="w-4 h-4" />Refresh
                            </button>
                        </div>
                    </div>
                )}

                {/* Idle / not-initiated / failed restart */}
                {!verified && !isAwaitingCustomer && !awaitingAdmin && (
                    <div className="text-center bg-gray-50 border-2 border-dashed border-gray-200 rounded-xl p-8">
                        <Video className="w-12 h-12 text-gray-400 mx-auto mb-3" />
                        <p className="text-sm font-semibold text-gray-700 mb-1">Ready to send</p>
                        <p className="text-xs text-gray-500 mb-4">
                            Verify the customer&apos;s phone before sending — the link goes to{' '}
                            <span className="font-semibold text-gray-700">{maskedPhone(phone)}</span>.
                        </p>
                        <PrimaryButton onClick={handleInitiate} loading={initiating}>
                            <Send className="w-4 h-4" />
                            <span>{state === 'failed' || state === 'rejected' ? 'Resend Video KYC Link' : 'Send Video KYC Link via SMS'}</span>
                        </PrimaryButton>
                    </div>
                )}

                {error && (
                    <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
                        {error}
                    </div>
                )}
            </div>
        </SectionCard>
    );
}
