'use client';

// Landing page for the emailed reset link — E-212.
//
// Validate-on-load: the token is checked with a read-only GET before the form
// renders, so an expired/used/superseded link says so immediately instead of
// letting the user type a new password twice and only then fail.
//
// No auto-sign-in. This flow never establishes a session (the reset endpoint
// uses the service-role client and issues no cookies), and sending the user to
// /login is also the better posture — it proves they can actually use the new
// password.

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { CheckCircle2, Eye, EyeOff, Loader2, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

type TokenError = 'MISSING_TOKEN' | 'INVALID_TOKEN' | 'EXPIRED' | 'USED' | 'SUPERSEDED';

// Every failure shows the SAME headline, so a third party who intercepts a link
// learns nothing about why it failed. Only the sub-copy differs, and only in
// ways that help the legitimate user act.
const ERROR_COPY: Record<TokenError | 'SERVER_ERROR', string> = {
    EXPIRED: 'Reset links are valid for 30 minutes. Request a new one from the sign-in page.',
    USED: "This link has already been used. If that wasn't you, contact it@itarang.com immediately.",
    SUPERSEDED: 'A newer reset link was sent to your email — please use that one instead.',
    INVALID_TOKEN: 'The link may have been copied incompletely. Request a new one from the sign-in page.',
    MISSING_TOKEN: 'The link may have been copied incompletely. Request a new one from the sign-in page.',
    SERVER_ERROR: 'Something went wrong on our side. Please try again in a moment.',
};

const INPUT =
    'w-full px-4 py-3 bg-white border border-gray-200 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all disabled:opacity-60';

export default function ResetPasswordClient() {
    const token = useSearchParams().get('token') ?? '';

    const [phase, setPhase] = useState<'checking' | 'invalid' | 'ready' | 'done'>('checking');
    const [reason, setReason] = useState<keyof typeof ERROR_COPY>('INVALID_TOKEN');
    const [maskedEmail, setMaskedEmail] = useState('');

    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const fail = useCallback((code: keyof typeof ERROR_COPY) => {
        setReason(code);
        setPhase('invalid');
    }, []);

    useEffect(() => {
        if (!token) {
            fail('MISSING_TOKEN');
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/auth/reset-password?token=${encodeURIComponent(token)}`, {
                    cache: 'no-store',
                });
                const json = await res.json().catch(() => null);
                if (cancelled) return;

                if (!json?.ok) {
                    fail((json?.error as TokenError) ?? 'SERVER_ERROR');
                    return;
                }
                setMaskedEmail(json.email_masked ?? '');
                setPhase('ready');
            } catch {
                if (!cancelled) fail('SERVER_ERROR');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [token, fail]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        // Same rules as /change-password, plus the 6-char floor /login already
        // applies — moved earlier so the user isn't charged a round-trip to
        // learn it. Deliberately NOT stricter than /change-password.
        if (!password || !confirmPassword) {
            setError('Please fill all fields');
            return;
        }
        if (password !== confirmPassword) {
            setError('Passwords do not match');
            return;
        }
        if (password.length < 6) {
            setError('Password must be at least 6 characters');
            return;
        }

        setSubmitting(true);
        try {
            const res = await fetch('/api/auth/reset-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, password }),
            });
            const json = await res.json().catch(() => null);

            if (!res.ok || !json?.ok) {
                // 410 means the token died between load and submit (expired,
                // or claimed by a parallel submit) — swap to the invalid card
                // rather than leaving a form that can never succeed.
                if (res.status === 410) {
                    fail((json?.error as TokenError) ?? 'INVALID_TOKEN');
                    return;
                }
                setError(json?.message || 'Could not update your password. Please try again.');
                return;
            }

            setPhase('done');
            toast.success('Password updated. Please sign in.');
            // window.location.assign, not router.push — the destination must
            // boot with the current build's manifest (same reason as the login
            // page's navigateTo helper).
            setTimeout(() => window.location.assign('/login'), 1500);
        } catch {
            setError('Something went wrong. Check your connection and try again.');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-[#F5F7FA] px-4 py-10">
            <div className="w-full max-w-md">
                <div className="mb-6 flex justify-center">
                    <Image
                        src="/logo-full.png"
                        alt="iTarang Logo"
                        width={180}
                        height={60}
                        className="h-11 w-auto object-contain"
                        priority
                    />
                </div>

                <div className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-black/5">
                    {phase === 'checking' && (
                        <div className="flex flex-col items-center gap-3 py-8">
                            <Loader2 className="h-6 w-6 animate-spin text-[#005596]" />
                            <p className="text-sm text-gray-500">Checking your reset link…</p>
                        </div>
                    )}

                    {phase === 'invalid' && (
                        <div className="text-center">
                            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-600">
                                <ShieldAlert className="h-6 w-6" />
                            </div>
                            <h1 className="mt-4 text-xl font-bold text-[#002B49]">
                                This reset link is no longer valid.
                            </h1>
                            <p className="mt-2 text-sm leading-relaxed text-gray-500">{ERROR_COPY[reason]}</p>
                            <Link
                                href="/login"
                                className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-lg bg-[#005596] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#00447a]"
                            >
                                Back to sign in
                            </Link>
                        </div>
                    )}

                    {phase === 'done' && (
                        <div className="text-center">
                            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                                <CheckCircle2 className="h-6 w-6" />
                            </div>
                            <h1 className="mt-4 text-xl font-bold text-[#002B49]">Password updated</h1>
                            <p className="mt-2 text-sm text-gray-500">
                                Taking you to the sign-in page…
                            </p>
                        </div>
                    )}

                    {phase === 'ready' && (
                        <form onSubmit={handleSubmit}>
                            <h1 className="text-2xl font-bold text-[#002B49]">Set a new password</h1>
                            {maskedEmail && (
                                <p className="mt-2 text-sm text-gray-500">
                                    for <span className="font-semibold text-gray-700">{maskedEmail}</span>
                                </p>
                            )}

                            <div className="mt-6 space-y-4">
                                <div>
                                    <label htmlFor="new-password" className="mb-2 block text-sm font-medium text-gray-700">
                                        New password
                                    </label>
                                    <div className="relative">
                                        <input
                                            id="new-password"
                                            type={showPassword ? 'text' : 'password'}
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            disabled={submitting}
                                            autoComplete="new-password"
                                            placeholder="At least 6 characters"
                                            className={`${INPUT} pr-11`}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowPassword((v) => !v)}
                                            className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 hover:text-gray-600"
                                            aria-label={showPassword ? 'Hide password' : 'Show password'}
                                        >
                                            {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                                        </button>
                                    </div>
                                </div>

                                <div>
                                    <label htmlFor="confirm-password" className="mb-2 block text-sm font-medium text-gray-700">
                                        Confirm new password
                                    </label>
                                    <input
                                        id="confirm-password"
                                        type={showPassword ? 'text' : 'password'}
                                        value={confirmPassword}
                                        onChange={(e) => setConfirmPassword(e.target.value)}
                                        disabled={submitting}
                                        autoComplete="new-password"
                                        placeholder="Re-enter the password"
                                        className={INPUT}
                                    />
                                </div>
                            </div>

                            {error && <p className="mt-3 text-xs font-medium text-red-500">{error}</p>}

                            <button
                                type="submit"
                                disabled={submitting}
                                className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-[#005596] px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#00447a] disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                                {submitting ? 'Updating…' : 'Update password'}
                            </button>

                            <Link
                                href="/login"
                                className="mt-4 block text-center text-sm font-medium text-blue-600 hover:text-blue-500"
                            >
                                Back to sign in
                            </Link>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
}
