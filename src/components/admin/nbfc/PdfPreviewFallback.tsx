"use client";

/**
 * Shared preview-card fallbacks for agreement / document thumbnails.
 * Rendered in place of the <iframe> when a PDF is still being probed
 * (loading) or can't be loaded on this server (missing). See
 * usePdfAvailability for the why.
 */
import { FileWarning } from "lucide-react";

/** Shown inside a preview card when the PDF file can't be loaded. */
export function PdfUnavailableBody({ height }: { height: number }) {
  return (
    <div
      className="w-full flex flex-col items-center justify-center gap-1.5 bg-[color:var(--color-bg)] text-center px-4"
      style={{ height }}
    >
      <FileWarning className="w-8 h-8 text-[color:var(--color-ink-muted)]" />
      <p className="text-[11px] font-semibold text-[color:var(--color-ink-muted)]">
        Preview unavailable on this server
      </p>
      <p className="text-[10px] text-[color:var(--color-ink-muted)] opacity-80 leading-tight">
        The uploaded file isn&apos;t present in this environment. Use
        &ldquo;Open in new tab&rdquo; or view on the environment where it was
        uploaded.
      </p>
    </div>
  );
}

/** Subtle skeleton while we probe whether the PDF resolves. */
export function PdfLoadingBody({ height }: { height: number }) {
  return (
    <div
      className="w-full bg-[color:var(--color-bg)] animate-pulse"
      style={{ height }}
    />
  );
}
