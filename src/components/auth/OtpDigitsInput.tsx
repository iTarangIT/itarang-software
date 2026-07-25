'use client';

// A length-parameterised OTP box row.
//
// The handlers are ported from ConsentOtpCard.tsx, which hardcodes 6 in ~8
// places (array init, `i < 5`, `slice(0,6)`, `inputsRef.current[5]`, two length
// comparisons and its copy) and so could not be reused for a 4-digit code.
// ConsentOtpCard is deliberately left untouched — it is live in the KYC consent
// flow; switching it over to this component is a safe follow-up, not part of
// this change.

import { useRef } from 'react';

type Props = {
    length: number;
    value: string[];
    onChange: (next: string[]) => void;
    disabled?: boolean;
    /** Fired once every box is filled — lets the caller auto-submit. */
    onComplete?: (code: string) => void;
};

export default function OtpDigitsInput({
    length,
    value,
    onChange,
    disabled = false,
    onComplete,
}: Props) {
    const inputsRef = useRef<(HTMLInputElement | null)[]>([]);

    const emit = (next: string[]) => {
        onChange(next);
        const joined = next.join('');
        if (joined.length === length && !next.some((d) => d === '')) {
            onComplete?.(joined);
        }
    };

    const onDigitChange = (i: number, raw: string) => {
        const digit = raw.replace(/\D/g, '').slice(-1);
        const next = [...value];
        next[i] = digit;
        emit(next);
        if (digit && i < length - 1) inputsRef.current[i + 1]?.focus();
    };

    const onKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Backspace' && !value[i] && i > 0) {
            inputsRef.current[i - 1]?.focus();
        }
        if (e.key === 'ArrowLeft' && i > 0) inputsRef.current[i - 1]?.focus();
        if (e.key === 'ArrowRight' && i < length - 1) inputsRef.current[i + 1]?.focus();
    };

    const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
        const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
        if (!pasted) return;
        e.preventDefault();
        const next = Array.from({ length }, (_, i) => pasted[i] ?? '');
        emit(next);
        inputsRef.current[Math.min(pasted.length, length) - 1]?.focus();
    };

    return (
        <div className="flex justify-center gap-3">
            {Array.from({ length }, (_, i) => (
                <input
                    key={i}
                    ref={(el) => {
                        inputsRef.current[i] = el;
                    }}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={1}
                    aria-label={`Digit ${i + 1}`}
                    value={value[i] ?? ''}
                    disabled={disabled}
                    onChange={(e) => onDigitChange(i, e.target.value)}
                    onKeyDown={(e) => onKeyDown(i, e)}
                    onPaste={onPaste}
                    className="h-14 w-12 rounded-xl border border-slate-200 bg-white text-center font-mono text-xl font-bold text-[#002B49] transition-colors focus:border-[#005596] focus:outline-none focus:ring-2 focus:ring-[#005596]/20 disabled:opacity-60"
                />
            ))}
        </div>
    );
}
