'use client';

// "Forgot password?" popup on /login — E-212.
//
// Deliberately NOT wired into the promise-based confirmDialog() host: that
// helper resolves a boolean and has no async/loading state, and this needs one
// (Share fires a network request). Structure/classes are copied from
// components/ui/confirm-dialog.tsx — there is no shadcn Dialog in this repo —
// with the login page's brand colours (#005596 / #00447a).
//
// The email is READ-ONLY here. The caller (login page) only opens this once the
// address in the login form has passed the same regex the sign-in path uses, so
// there is nothing to edit and no second place for the value to diverge.

import { useEffect, useState } from 'react';
import { KeyRound, Loader2, Mail } from 'lucide-react';

type Props = {
    open: boolean;
    /** Already trimmed + lower-cased by the caller. */
    email: string;
    onClose: () => void;
};

export default function ForgotPasswordModal({ open, email, onClose }: Props) {
    const [phase, setPhase] = useState<'confirm' | 'sending' | 'sent'>('confirm');
    const [error, setError] = useState<string | null>(null);

    // Reset to a clean slate whenever the dialog is reopened.
    useEffect(() => {
        if (open) {
            setPhase('confirm');
            setError(null);
        }
    }, [open]);

    // Escape closes, body scroll locks. Ignored mid-send so a half-sent request
    // can't be orphaned by a stray keypress.
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && phase !== 'sending') onClose();
        };
        document.addEventListener('keydown', onKey);
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = prevOverflow;
        };
    }, [open, phase, onClose]);

    if (!open) return null;

    const handleShare = async () => {
        setPhase('sending');
        setError(null);
        try {
            const res = await fetch('/api/auth/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
            });
            const json = await res.json().catch(() => null);

            if (!res.ok) {
                // The only non-200s are INVALID_EMAIL and RATE_LIMITED, neither
                // of which reveals whether the account exists.
                setError(
                    json?.message ||
                        (json?.error === 'RATE_LIMITED'
                            ? 'Too many requests. Please try again in a few minutes.'
                            : 'Could not send the reset link. Please try again.'),
                );
                setPhase('confirm');
                return;
            }
            setPhase('sent');
        } catch {
            setError('Network error. Check your connection and try again.');
            setPhase('confirm');
        }
    };

    const isSent = phase === 'sent';
    const isSending = phase === 'sending';

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
            <div
                className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-150"
                onClick={() => {
                    if (!isSending) onClose();
                }}
            />
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="forgot-password-title"
                className="relative w-full max-w-md rounded-2xl bg-white shadow-2xl ring-1 ring-black/5 p-6 animate-in fade-in zoom-in-95 duration-150"
            >
                <div className="flex items-start gap-4">
                    <div
                        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${
                            isSent ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-[#005596]'
                        }`}
                    >
                        {isSent ? <KeyRound className="h-5 w-5" /> : <Mail className="h-5 w-5" />}
                    </div>
                    <div className="min-w-0 flex-1 pt-0.5">
                        <h3 id="forgot-password-title" className="text-base font-bold text-slate-900">
                            {isSent ? 'Check your email' : 'Reset your password'}
                        </h3>
                        <p className="mt-1.5 text-sm leading-relaxed text-slate-500">
                            {isSent
                                ? 'If an account exists for this address, a password-update link has been sent. Open it to set a new password — the link is valid for 30 minutes.'
                                : 'A password-update link will be sent to your registered email address. Please check your inbox and follow the link to update your password.'}
                        </p>
                    </div>
                </div>

                <div className="mt-4 rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                        Registered email
                    </p>
                    <p className="mt-1 break-all text-sm font-semibold text-[#002B49]">{email}</p>
                </div>

                {isSent && (
                    <p className="mt-3 text-xs leading-relaxed text-slate-400">
                        Nothing in your inbox after a few minutes? Check your spam folder, or
                        contact{' '}
                        <a href="mailto:it@itarang.com" className="font-medium text-blue-600 hover:text-blue-500">
                            it@itarang.com
                        </a>
                        .
                    </p>
                )}

                {error && <p className="mt-3 text-xs font-medium text-red-500">{error}</p>}

                <div className="mt-6 flex justify-end gap-3">
                    {isSent ? (
                        <button
                            type="button"
                            autoFocus
                            onClick={onClose}
                            className="h-10 rounded-xl bg-[#005596] px-4 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[#00447a]"
                        >
                            Close
                        </button>
                    ) : (
                        <>
                            <button
                                type="button"
                                onClick={onClose}
                                disabled={isSending}
                                className="h-10 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-60"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                autoFocus
                                onClick={handleShare}
                                disabled={isSending}
                                className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#005596] px-4 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[#00447a] disabled:opacity-60"
                            >
                                {isSending && <Loader2 className="h-4 w-4 animate-spin" />}
                                {isSending ? 'Sending…' : 'Share'}
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
