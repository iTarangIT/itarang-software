'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    AlertCircle, CheckCircle2, Clock, Loader2, RefreshCw, Video, X,
} from 'lucide-react';
import { SectionCard, PrimaryButton, SecondaryButton } from './shared';

const MAX_RECORDING_SECONDS = 8;
const MIN_RECORDING_SECONDS = 3;

type Phase = 'idle' | 'requesting' | 'recording' | 'review' | 'uploading' | 'done' | 'error';

interface VideoKYCSectionProps {
    leadId: string;
    customerName?: string;
    /** Verification row status from /api/kyc/[leadId]/verifications */
    status: string;
    /** Server-side failure reason (e.g. Decentro confidence too low, or admin rejection) */
    failedReason?: string | null;
    /** Confidence score 0-100 from match_score */
    confidence?: number | null;
    /** Triggered after a successful upload so the parent page can re-fetch verifications */
    onSubmitted?: () => void;
    /** Re-recording is disabled once admin has verified */
    locked?: boolean;
}

function statusBadge(status: string) {
    const s = (status || '').toLowerCase();
    if (['verified', 'success', 'admin_verified', 'manual_verified'].includes(s)) {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold"><CheckCircle2 className="w-3 h-3" />Verified</span>;
    }
    if (s === 'admin_review_pending') {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-bold"><Clock className="w-3 h-3" />Awaiting Admin Review</span>;
    }
    if (['failed', 'rejected'].includes(s)) {
        return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-red-100 text-red-700 rounded-full text-xs font-bold"><AlertCircle className="w-3 h-3" />Failed</span>;
    }
    return <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-gray-100 text-gray-600 rounded-full text-xs font-bold">Not Recorded</span>;
}

export default function VideoKYCSection({
    leadId,
    customerName,
    status,
    failedReason,
    confidence,
    onSubmitted,
    locked = false,
}: VideoKYCSectionProps) {
    const [phase, setPhase] = useState<Phase>('idle');
    const [error, setError] = useState<string | null>(null);
    const [elapsed, setElapsed] = useState(0);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);

    const livePreviewRef = useRef<HTMLVideoElement | null>(null);
    const reviewVideoRef = useRef<HTMLVideoElement | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const recordedChunksRef = useRef<Blob[]>([]);
    const recordedBlobRef = useRef<Blob | null>(null);
    const recordedMimeRef = useRef<string>('video/webm');
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const verified = ['verified', 'success', 'admin_verified', 'manual_verified'].includes((status || '').toLowerCase());
    const awaitingReview = (status || '').toLowerCase() === 'admin_review_pending';
    const showRecorder = !verified && !awaitingReview && phase !== 'done';

    const stopTracks = useCallback(() => {
        mediaStreamRef.current?.getTracks().forEach(t => t.stop());
        mediaStreamRef.current = null;
    }, []);

    const clearTimers = useCallback(() => {
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        if (autoStopRef.current) { clearTimeout(autoStopRef.current); autoStopRef.current = null; }
    }, []);

    useEffect(() => () => {
        clearTimers();
        stopTracks();
        if (previewUrl) URL.revokeObjectURL(previewUrl);
    }, [clearTimers, stopTracks, previewUrl]);

    const pickSupportedMime = (): string => {
        const candidates = [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm',
            'video/mp4',
        ];
        for (const m of candidates) {
            if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(m)) return m;
        }
        return 'video/webm';
    };

    const handleStart = async () => {
        setError(null);
        setPhase('requesting');
        try {
            if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
                throw new Error('Camera access is not supported in this browser. Please use Chrome/Edge on a desktop or Safari on iOS 14.3+.');
            }
            // Decentro Farsight rejects video below 800×600 with
            // "Video resolution is lower than expected." Aim for 1280×720
            // (HD, widely supported by webcams) and enforce 800×600 as a
            // hard floor — if the device truly can't deliver that, fail
            // here with a clear browser error instead of uploading a
            // useless low-res clip that Decentro will reject after upload.
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'user',
                    width: { min: 800, ideal: 1280 },
                    height: { min: 600, ideal: 720 },
                },
                audio: true,
            });
            mediaStreamRef.current = stream;
            if (livePreviewRef.current) {
                livePreviewRef.current.srcObject = stream;
                livePreviewRef.current.muted = true;
                await livePreviewRef.current.play().catch(() => {});
            }

            const mime = pickSupportedMime();
            recordedMimeRef.current = mime;
            const rec = new MediaRecorder(stream, { mimeType: mime });
            recordedChunksRef.current = [];
            recordedBlobRef.current = null;
            rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data); };
            rec.onstop = () => {
                const blob = new Blob(recordedChunksRef.current, { type: mime });
                recordedBlobRef.current = blob;
                if (previewUrl) URL.revokeObjectURL(previewUrl);
                const url = URL.createObjectURL(blob);
                setPreviewUrl(url);
                stopTracks();
                setPhase('review');
            };
            mediaRecorderRef.current = rec;
            rec.start();

            setElapsed(0);
            setPhase('recording');
            timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
            autoStopRef.current = setTimeout(() => {
                handleStop();
            }, MAX_RECORDING_SECONDS * 1000);
        } catch (err: any) {
            const name = err?.name || '';
            const message =
                name === 'NotAllowedError' ? 'Camera/microphone permission was denied. Allow access and try again.' :
                name === 'NotFoundError' ? 'No camera or microphone was found on this device.' :
                name === 'NotReadableError' ? 'The camera is already in use by another application.' :
                name === 'OverconstrainedError' ? 'This camera cannot deliver the minimum required resolution (800×600). Try a different camera or device.' :
                err?.message || 'Could not start recording.';
            setError(message);
            setPhase('error');
            stopTracks();
            clearTimers();
        }
    };

    const handleStop = () => {
        clearTimers();
        const rec = mediaRecorderRef.current;
        if (rec && rec.state !== 'inactive') {
            try { rec.stop(); } catch { /* ignore */ }
        }
    };

    const handleRetake = () => {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(null);
        recordedBlobRef.current = null;
        recordedChunksRef.current = [];
        setElapsed(0);
        setError(null);
        setPhase('idle');
    };

    const handleSubmit = async () => {
        const blob = recordedBlobRef.current;
        if (!blob) { setError('Nothing to submit — please record first.'); return; }
        if (elapsed < MIN_RECORDING_SECONDS) {
            setError(`Recording is too short. Please record at least ${MIN_RECORDING_SECONDS} seconds.`);
            return;
        }
        setPhase('uploading');
        setError(null);
        try {
            const form = new FormData();
            const ext = recordedMimeRef.current.includes('mp4') ? 'mp4' : 'webm';
            form.append('video', blob, `vkyc.${ext}`);
            form.append('applicant', 'primary');

            const res = await fetch(`/api/kyc/${leadId}/decentro/video-liveness`, {
                method: 'POST',
                body: form,
            });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data?.error?.message || data?.message || 'Upload failed');
            }
            // Decentro returned FAILURE → treat as error so dealer re-records.
            if (data.success === false) {
                throw new Error(data?.failed_reason || data?.message || 'Liveness check failed. Please re-record with the customer\'s face clearly visible.');
            }
            setPhase('done');
            onSubmitted?.();
        } catch (err: any) {
            setError(err?.message || 'Could not submit video. Please try again.');
            setPhase('error');
        }
    };

    const remaining = Math.max(0, MAX_RECORDING_SECONDS - elapsed);

    return (
        <SectionCard title="Video KYC (Customer)" action={statusBadge(status)}>
            <div className="space-y-5">
                {/* Top instruction strip */}
                <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-900">
                    <p className="font-semibold mb-1">Why Video KYC?</p>
                    <p className="text-blue-800/90 leading-relaxed">
                        RBI guidelines require a short live video of the customer for finance leads. Position
                        {customerName ? <> <span className="font-semibold">{customerName}</span></> : ' the customer'} in
                        good lighting facing the camera. Recording is {MIN_RECORDING_SECONDS}-{MAX_RECORDING_SECONDS} seconds.
                    </p>
                </div>

                {/* Verified state */}
                {verified && (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-center gap-3">
                        <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                        <div className="text-sm text-emerald-800">
                            <p className="font-semibold">Video KYC verified by admin.</p>
                            {typeof confidence === 'number' && (
                                <p className="text-xs text-emerald-700/80 mt-0.5">Decentro liveness confidence: {confidence.toFixed(1)}%</p>
                            )}
                        </div>
                    </div>
                )}

                {/* Awaiting admin review */}
                {awaitingReview && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center gap-3">
                        <Clock className="w-5 h-5 text-amber-600 flex-shrink-0" />
                        <div className="text-sm text-amber-800">
                            <p className="font-semibold">Submitted — awaiting admin review.</p>
                            <p className="text-xs text-amber-700/80 mt-0.5">Submit-for-Verification stays disabled until admin accepts the recording.</p>
                        </div>
                    </div>
                )}

                {/* Failed reason banner */}
                {failedReason && (status || '').toLowerCase() !== 'admin_review_pending' && !verified && (
                    <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
                        <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                        <div className="text-sm text-red-800">
                            <p className="font-semibold">Previous recording was rejected</p>
                            <p className="text-xs text-red-700/90 mt-0.5">{failedReason}</p>
                        </div>
                    </div>
                )}

                {/* Recorder workspace */}
                {showRecorder && !locked && (
                    <div className="space-y-4">
                        {/* Idle */}
                        {(phase === 'idle' || phase === 'error') && (
                            <div className="text-center bg-gray-50 border-2 border-dashed border-gray-200 rounded-xl p-8">
                                <Video className="w-12 h-12 text-gray-400 mx-auto mb-3" />
                                <p className="text-sm font-semibold text-gray-700 mb-1">Ready to record</p>
                                <p className="text-xs text-gray-500 mb-4">The customer should look directly at the camera. Speak the customer's name once.</p>
                                <PrimaryButton onClick={handleStart}>
                                    <Video className="w-4 h-4" />
                                    <span>Start Recording</span>
                                </PrimaryButton>
                            </div>
                        )}

                        {/* Requesting permission */}
                        {phase === 'requesting' && (
                            <div className="text-center bg-gray-50 border border-gray-200 rounded-xl p-8">
                                <Loader2 className="w-8 h-8 text-blue-600 animate-spin mx-auto mb-3" />
                                <p className="text-sm text-gray-700">Requesting camera & microphone permission…</p>
                            </div>
                        )}

                        {/* Live recording */}
                        {phase === 'recording' && (
                            <div className="space-y-3">
                                <div className="relative rounded-xl overflow-hidden bg-black aspect-video max-w-md mx-auto">
                                    <video ref={livePreviewRef} autoPlay playsInline muted className="w-full h-full object-cover" />
                                    <div className="absolute top-3 left-3 inline-flex items-center gap-1.5 px-2 py-1 bg-red-600 text-white rounded text-xs font-bold">
                                        <span className="w-2 h-2 rounded-full bg-white animate-pulse" />REC
                                    </div>
                                    <div className="absolute top-3 right-3 px-2 py-1 bg-black/60 text-white rounded text-xs font-mono">
                                        {String(elapsed).padStart(2, '0')}s · {remaining}s left
                                    </div>
                                </div>
                                <div className="flex justify-center">
                                    <button
                                        onClick={handleStop}
                                        disabled={elapsed < 1}
                                        className="px-5 py-2.5 bg-red-600 hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-xl text-sm font-bold inline-flex items-center gap-2 transition-colors"
                                    >
                                        <X className="w-4 h-4" />Stop Recording
                                    </button>
                                </div>
                                <p className="text-xs text-center text-gray-500">Auto-stops at {MAX_RECORDING_SECONDS}s</p>
                            </div>
                        )}

                        {/* Review before submit */}
                        {phase === 'review' && previewUrl && (
                            <div className="space-y-3">
                                <div className="rounded-xl overflow-hidden bg-black aspect-video max-w-md mx-auto">
                                    <video ref={reviewVideoRef} src={previewUrl} controls playsInline className="w-full h-full object-contain" />
                                </div>
                                <div className="flex flex-wrap items-center justify-center gap-3">
                                    <SecondaryButton onClick={handleRetake}>
                                        <RefreshCw className="w-4 h-4" />
                                        <span>Re-record</span>
                                    </SecondaryButton>
                                    <PrimaryButton onClick={handleSubmit}>
                                        <CheckCircle2 className="w-4 h-4" />
                                        <span>Submit for Verification</span>
                                    </PrimaryButton>
                                </div>
                                <p className="text-xs text-center text-gray-500">Duration: {elapsed}s</p>
                            </div>
                        )}

                        {/* Uploading */}
                        {phase === 'uploading' && (
                            <div className="text-center bg-blue-50 border border-blue-100 rounded-xl p-8">
                                <Loader2 className="w-8 h-8 text-blue-600 animate-spin mx-auto mb-3" />
                                <p className="text-sm font-semibold text-blue-900">Uploading & running liveness check…</p>
                                <p className="text-xs text-blue-700/80 mt-1">This usually takes 5-10 seconds.</p>
                            </div>
                        )}
                    </div>
                )}

                {/* Done (just submitted in this session) */}
                {phase === 'done' && (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-800">
                        <p className="font-semibold">Video submitted successfully.</p>
                        <p className="text-xs text-emerald-700/80 mt-0.5">The admin will review the recording shortly.</p>
                    </div>
                )}

                {/* Error */}
                {error && (
                    <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
                        {error}
                    </div>
                )}
            </div>
        </SectionCard>
    );
}
