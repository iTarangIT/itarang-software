"use client";

// The "Preview" of a scheduled email report: the email exactly as it would go
// out now, rendered in a sandboxed frame. Nothing is sent. Shared by the
// Reports pages (admin and Sales Head).

import { X } from "lucide-react";

export interface EmailPreview {
    label: string;
    subject: string;
    html: string;
    for_day: string;
}

export function EmailPreviewModal({ preview, onClose }: { preview: EmailPreview; onClose: () => void }) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
            <div className="flex h-[85vh] w-full max-w-4xl flex-col rounded-xl bg-surface shadow-card" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
                    <div>
                        <div className="text-sm font-semibold text-ink">{preview.subject}</div>
                        <p className="text-xs text-ink-muted">
                            Preview of {preview.label} for {preview.for_day}, with the figures as they stand now. Nothing was sent.
                        </p>
                    </div>
                    <button type="button" aria-label="Close preview" onClick={onClose} className="text-ink-muted hover:text-ink">
                        <X className="h-5 w-5" />
                    </button>
                </div>
                {/* sandbox with no allowances: the email's HTML can run no script and reach nothing. */}
                <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="w-full flex-1 rounded-b-xl bg-white" />
            </div>
        </div>
    );
}
