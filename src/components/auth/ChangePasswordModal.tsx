'use client';

// In-app "Change Password" — E-213.
//
// Mounted ONCE in the root layout (inside <AuthProvider>, which it needs for
// useAuth) and opened from the uiStore by four triggers: the shared header, the
// NBFC portal header, the Risk Head shell, and the profile page's Security
// card.
//
// WHY THERE IS NO CURRENT-PASSWORD FIELD: this was an explicit product
// decision — control of the registered mailbox is the proof of identity, via
// the emailed code. Do not "fix" this by adding one without checking first;
// the server (POST .../confirm) does not accept a currentPassword either.
//
// The separate root-level /change-password page is NOT this. That one is the
// forced first-login reset driven by users.must_change_password, has no OTP
// gate, and is deliberately untouched.

import { useEffect, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, KeyRound, Loader2, Mail } from 'lucide-react';
import { useUIStore } from '@/store/uiStore';
import { useAuth } from '@/components/auth/AuthProvider';
import OtpDigitsInput from '@/components/auth/OtpDigitsInput';

type Phase = 'intro' | 'otp' | 'password' | 'done';

const INPUT =
    'w-full rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 placeholder-slate-400 transition-all focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#005596] disabled:opacity-60';

function formatCountdown(totalSeconds: number): string {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

export default function ChangePasswordModal() {
    const open = useUIStore((s) => s.changePasswordOpen);
    const close = useUIStore((s) => s.closeChangePassword);
    const { user, refreshUser } = useAuth();

    const [phase, setPhase] = useState<Phase>('intro');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [otpLength, setOtpLength] = useState(4);
    const [digits, setDigits] = useState<string[]>([]);
    const [maskedEmail, setMaskedEmail] = useState('');
    const [secondsLeft, setSecondsLeft] = useState(0);
    const [sendCount, setSendCount] = useState(0);
    const [maxSends, setMaxSends] = useState(3);

    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);

    // Fresh slate every time the dialog is opened.
    useEffect(() => {
        if (!open) return;
        setPhase('intro');
        setBusy(false);
        setError(null);
        setDigits([]);
        setMaskedEmail('');
        setSecondsLeft(0);
        setSendCount(0);
        setPassword('');
        setConfirmPassword('');
        setShowPassword(false);
    }, [open]);

    // Escape closes — but never mid-request, so a half-sent code can't be
    // orphaned by a stray keypress.
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !busy) close();
        };
        document.addEventListener('keydown', onKey);
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = prevOverflow;
        };
    }, [open, busy, close]);

    // Countdown on the live code.
    useEffect(() => {
        if (secondsLeft <= 0) return;
        const t = setInterval(() => setSecondsLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
        return () => clearInterval(t);
    }, [secondsLeft]);

    if (!open) return null;

    const sendCode = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch('/api/auth/change-password/send-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({}),
            });
            const json = await res.json().catch(() => null);

            if (!res.ok || !json?.ok) {
                setError(json?.message || 'Could not send the code. Please try again.');
                return;
            }

            setMaskedEmail(json.maskedEmail ?? '');
            setOtpLength(json.otpLength ?? 4);
            setDigits(Array.from({ length: json.otpLength ?? 4 }, () => ''));
            setSecondsLeft(json.expiresInSeconds ?? 600);
            setSendCount(json.sendCount ?? 1);
            setMaxSends(json.maxSends ?? 3);
            setPhase('otp');
        } catch {
            setError('Network error. Check your connection and try again.');
        } finally {
            setBusy(false);
        }
    };

    const verifyCode = async (code?: string) => {
        const otp = code ?? digits.join('');
        setBusy(true);
        setError(null);
        try {
            const res = await fetch('/api/auth/change-password/verify-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ otp }),
            });
            const json = await res.json().catch(() => null);

            if (!res.ok || !json?.ok) {
                setError(json?.message || 'Could not verify that code.');
                setDigits(Array.from({ length: otpLength }, () => ''));
                return;
            }
            setPhase('password');
        } catch {
            setError('Network error. Check your connection and try again.');
        } finally {
            setBusy(false);
        }
    };

    const submitPassword = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);

        // Same rules as /change-password, plus the 6-char floor the login page
        // already applies — checked here so the user isn't charged a round-trip.
        if (!password || !confirmPassword) {
            setError('Please fill both fields.');
            return;
        }
        if (password !== confirmPassword) {
            setError('Passwords do not match.');
            return;
        }
        if (password.length < 6) {
            setError('Password must be at least 6 characters.');
            return;
        }

        setBusy(true);
        try {
            const res = await fetch('/api/auth/change-password/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ password }),
            });
            const json = await res.json().catch(() => null);

            if (!res.ok || !json?.ok) {
                // 410 means the verification lapsed between steps — send them
                // back to the start rather than leaving a form that can never
                // succeed.
                if (res.status === 410) {
                    setPhase('intro');
                    setError(json?.message || 'Your verification expired. Please start again.');
                    return;
                }
                setError(json?.message || 'Could not update your password.');
                return;
            }

            setPhase('done');
            void refreshUser();
        } catch {
            setError('Network error. Check your connection and try again.');
        } finally {
            setBusy(false);
        }
    };

    const resendDisabled = busy || sendCount >= maxSends;
    const headerEmail = maskedEmail || user?.email || '';

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
            <div
                className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-150"
                onClick={() => {
                    if (!busy) close();
                }}
            />
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="change-password-title"
                className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-black/5 animate-in fade-in zoom-in-95 duration-150"
            >
                <div className="flex items-start gap-4">
                    <div
                        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${
                            phase === 'done'
                                ? 'bg-emerald-50 text-emerald-600'
                                : 'bg-blue-50 text-[#005596]'
                        }`}
                    >
                        {phase === 'done' ? (
                            <CheckCircle2 className="h-5 w-5" />
                        ) : phase === 'intro' ? (
                            <Mail className="h-5 w-5" />
                        ) : (
                            <KeyRound className="h-5 w-5" />
                        )}
                    </div>
                    <div className="min-w-0 flex-1 pt-0.5">
                        <h3 id="change-password-title" className="text-base font-bold text-slate-900">
                            {phase === 'intro' && 'Change your password'}
                            {phase === 'otp' && 'Enter the code'}
                            {phase === 'password' && 'Set a new password'}
                            {phase === 'done' && 'Password updated'}
                        </h3>
                        <p className="mt-1.5 text-sm leading-relaxed text-slate-500">
                            {phase === 'intro' &&
                                `We'll email a ${otpLength}-digit code to your registered address to confirm it's you.`}
                            {phase === 'otp' &&
                                `Enter the ${otpLength}-digit code we sent to ${headerEmail}.`}
                            {phase === 'password' &&
                                'Verified. Choose a new password for your account.'}
                            {phase === 'done' &&
                                'Your password has been changed. Use it the next time you sign in.'}
                        </p>
                    </div>
                </div>

                {phase === 'intro' && (
                    <div className="mt-4 rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                            Registered email
                        </p>
                        <p className="mt-1 break-all text-sm font-semibold text-[#002B49]">
                            {user?.email || '—'}
                        </p>
                    </div>
                )}

                {phase === 'otp' && (
                    <div className="mt-5 space-y-3">
                        <OtpDigitsInput
                            length={otpLength}
                            value={digits}
                            onChange={setDigits}
                            disabled={busy}
                            onComplete={(code) => void verifyCode(code)}
                        />
                        <div className="flex items-center justify-between text-xs text-slate-500">
                            <span>
                                {secondsLeft > 0
                                    ? `Expires in ${formatCountdown(secondsLeft)}`
                                    : 'Code expired'}
                            </span>
                            <button
                                type="button"
                                onClick={() => void sendCode()}
                                disabled={resendDisabled}
                                className="font-semibold text-blue-600 hover:text-blue-500 disabled:cursor-not-allowed disabled:text-slate-400"
                            >
                                Resend ({sendCount}/{maxSends})
                            </button>
                        </div>
                    </div>
                )}

                {phase === 'password' && (
                    <form onSubmit={submitPassword} className="mt-5 space-y-4">
                        <div>
                            <label htmlFor="cp-new" className="mb-2 block text-sm font-medium text-slate-700">
                                New password
                            </label>
                            <div className="relative">
                                <input
                                    id="cp-new"
                                    type={showPassword ? 'text' : 'password'}
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    disabled={busy}
                                    autoComplete="new-password"
                                    placeholder="At least 6 characters"
                                    className={`${INPUT} pr-11`}
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword((v) => !v)}
                                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400 hover:text-slate-600"
                                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                                >
                                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                </button>
                            </div>
                        </div>
                        <div>
                            <label htmlFor="cp-confirm" className="mb-2 block text-sm font-medium text-slate-700">
                                Confirm new password
                            </label>
                            <input
                                id="cp-confirm"
                                type={showPassword ? 'text' : 'password'}
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                disabled={busy}
                                autoComplete="new-password"
                                placeholder="Re-enter the password"
                                className={INPUT}
                            />
                        </div>
                        {error && <p className="text-xs font-medium text-red-500">{error}</p>}
                        <div className="flex justify-end gap-3 pt-1">
                            <button
                                type="button"
                                onClick={close}
                                disabled={busy}
                                className="h-10 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-60"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={busy}
                                className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#005596] px-4 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[#00447a] disabled:opacity-60"
                            >
                                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                                {busy ? 'Updating…' : 'Update password'}
                            </button>
                        </div>
                    </form>
                )}

                {error && phase !== 'password' && (
                    <p className="mt-3 text-xs font-medium text-red-500">{error}</p>
                )}

                {phase !== 'password' && (
                    <div className="mt-6 flex justify-end gap-3">
                        {phase === 'done' ? (
                            <button
                                type="button"
                                autoFocus
                                onClick={close}
                                className="h-10 rounded-xl bg-[#005596] px-4 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[#00447a]"
                            >
                                Done
                            </button>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    onClick={close}
                                    disabled={busy}
                                    className="h-10 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-60"
                                >
                                    Cancel
                                </button>
                                {phase === 'intro' && (
                                    <button
                                        type="button"
                                        autoFocus
                                        onClick={() => void sendCode()}
                                        disabled={busy}
                                        className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#005596] px-4 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[#00447a] disabled:opacity-60"
                                    >
                                        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                                        {busy ? 'Sending…' : 'Send code'}
                                    </button>
                                )}
                                {phase === 'otp' && (
                                    <button
                                        type="button"
                                        onClick={() => void verifyCode()}
                                        disabled={busy || digits.join('').length !== otpLength}
                                        className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#005596] px-4 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[#00447a] disabled:opacity-60"
                                    >
                                        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                                        {busy ? 'Verifying…' : 'Verify'}
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
