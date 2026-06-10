'use client';

// Premium, promise-based confirmation dialog — a drop-in replacement for the
// native window.confirm(). Call `confirmDialog(...)` from anywhere and await the
// boolean result; a single <ConfirmDialogHost /> (mounted in the root layout)
// renders the centered modal. Falls back to window.confirm() if the host isn't
// mounted yet, so a confirm can never silently no-op.
//
//   if (!(await confirmDialog("Discard draft?"))) return;
//   if (!(await confirmDialog({ title: "Close lead?", message: "...", variant: "danger" }))) return;

import { useEffect, useState } from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';

export type ConfirmOptions = {
    title?: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
    /** 'danger' uses a red accent + warning icon for destructive/irreversible actions. */
    variant?: 'default' | 'danger';
};

type PendingConfirm = ConfirmOptions & { resolve: (value: boolean) => void };

// Single in-memory channel to the mounted host. Module-level so any module can
// trigger a dialog without prop-drilling a context.
let enqueue: ((req: PendingConfirm) => void) | null = null;

export function confirmDialog(opts: ConfirmOptions | string): Promise<boolean> {
    const options: ConfirmOptions = typeof opts === 'string' ? { message: opts } : opts;
    return new Promise<boolean>((resolve) => {
        if (!enqueue) {
            // Host not mounted (e.g. SSR or before hydration) — degrade gracefully.
            resolve(
                typeof window !== 'undefined'
                    ? window.confirm(options.message || options.title || 'Are you sure?')
                    : false,
            );
            return;
        }
        enqueue({ ...options, resolve });
    });
}

export function ConfirmDialogHost() {
    const [pending, setPending] = useState<PendingConfirm | null>(null);

    useEffect(() => {
        enqueue = (req) => setPending(req);
        return () => {
            enqueue = null;
        };
    }, []);

    // Close on Escape (treated as Cancel) and lock body scroll while open.
    useEffect(() => {
        if (!pending) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') close(false);
        };
        document.addEventListener('keydown', onKey);
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = prevOverflow;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pending]);

    if (!pending) return null;

    const {
        title,
        message,
        confirmText = 'Confirm',
        cancelText = 'Cancel',
        variant = 'default',
        resolve,
    } = pending;
    const isDanger = variant === 'danger';

    const close = (value: boolean) => {
        resolve(value);
        setPending(null);
    };

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-150"
                onClick={() => close(false)}
            />
            {/* Card */}
            <div
                role="alertdialog"
                aria-modal="true"
                className="relative w-full max-w-md rounded-2xl bg-white shadow-2xl ring-1 ring-black/5 p-6 animate-in fade-in zoom-in-95 duration-150"
            >
                <div className="flex items-start gap-4">
                    <div
                        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${
                            isDanger ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-[#0047AB]'
                        }`}
                    >
                        {isDanger ? <AlertTriangle className="h-5 w-5" /> : <HelpCircle className="h-5 w-5" />}
                    </div>
                    <div className="min-w-0 flex-1 pt-0.5">
                        <h3 className="text-base font-bold text-slate-900">
                            {title || (isDanger ? 'Are you sure?' : 'Please confirm')}
                        </h3>
                        {message && (
                            <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{message}</p>
                        )}
                    </div>
                </div>

                <div className="mt-6 flex justify-end gap-3">
                    <button
                        type="button"
                        onClick={() => close(false)}
                        className="h-10 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-50"
                    >
                        {cancelText}
                    </button>
                    <button
                        type="button"
                        autoFocus
                        onClick={() => close(true)}
                        className={`h-10 rounded-xl px-4 text-sm font-bold text-white shadow-sm transition-colors ${
                            isDanger ? 'bg-red-600 hover:bg-red-700' : 'bg-[#0047AB] hover:bg-[#003a8c]'
                        }`}
                    >
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>
    );
}
