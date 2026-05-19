"use client";

// Centered modal primitive shared by every action form in this module.
// ESC closes, backdrop click closes, body scroll locks while open. No
// external dialog library — mirrors the lead-v2-modals.tsx pattern that
// already lives in the codebase.

import { useEffect } from "react";
import { X } from "lucide-react";
import { createPortal } from "react-dom";

type Props = {
    open: boolean;
    onClose: () => void;
    title: string;
    subtitle?: string;
    width?: "sm" | "md" | "lg" | "xl";
    children: React.ReactNode;
    footer?: React.ReactNode;
    closeOnBackdrop?: boolean;
};

const WIDTHS: Record<NonNullable<Props["width"]>, string> = {
    sm: "max-w-md",
    md: "max-w-xl",
    lg: "max-w-3xl",
    xl: "max-w-5xl",
};

export function Modal({
    open,
    onClose,
    title,
    subtitle,
    width = "md",
    children,
    footer,
    closeOnBackdrop = true,
}: Props) {
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.body.style.overflow = "hidden";
        window.addEventListener("keydown", onKey);
        return () => {
            document.body.style.overflow = "";
            window.removeEventListener("keydown", onKey);
        };
    }, [open, onClose]);

    if (!open) return null;
    if (typeof window === "undefined") return null;

    return createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div
                className="absolute inset-0 bg-black/40 backdrop-blur-sm"
                onClick={closeOnBackdrop ? onClose : undefined}
            />
            <div
                className={`relative w-full ${WIDTHS[width]} max-h-[90vh] flex flex-col bg-white rounded-xl shadow-2xl border border-gray-100 overflow-hidden`}
                role="dialog"
                aria-modal="true"
                aria-labelledby="modal-title"
            >
                <header className="px-6 pt-5 pb-4 border-b border-gray-100 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <h2 id="modal-title" className="text-lg font-semibold text-gray-900 truncate">
                            {title}
                        </h2>
                        {subtitle && (
                            <p className="text-sm text-gray-500 mt-0.5 truncate">{subtitle}</p>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="shrink-0 p-1 rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </header>
                <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
                {footer && (
                    <footer className="px-6 py-3 border-t border-gray-100 bg-gray-50/50 flex items-center justify-end gap-2">
                        {footer}
                    </footer>
                )}
            </div>
        </div>,
        document.body,
    );
}
