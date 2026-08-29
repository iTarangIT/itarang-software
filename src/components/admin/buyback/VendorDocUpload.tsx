"use client";

/**
 * One document slot on the vendor onboarding form (E-223).
 *
 * Modelled on src/components/buyback/ui/EvidenceUpload.tsx — same dashed empty
 * state, same green filled chip with "Replace", same rule that a failed replace
 * KEEPS the previous value rather than silently clearing a document that was
 * already attached. Two differences, both structural:
 *
 *  · It posts `kind` and no `request_id`. There is no request, and no vendor
 *    either — that is the whole point of the uploads route it talks to.
 *  · It holds a `document_id`, not an s3 key. The form submits ids; the server
 *    never accepts a client-supplied storage path.
 *
 * Styled for the navy CRM dialect (BRD §6.B tokens) rather than the buyback
 * kit's slate/green, because it sits inside card-iTarang sections.
 */

import { useRef, useState } from "react";

import type { VendorDocType } from "@/lib/buyback/vendor-docs";

export interface VendorDocValue {
  documentId: string;
  fileName: string;
}

export default function VendorDocUpload({
  kind,
  label,
  required = false,
  value,
  onChange,
  error: validationError,
  disabled = false,
}: {
  kind: VendorDocType;
  label: string;
  required?: boolean;
  value: VendorDocValue | null;
  onChange: (v: VendorDocValue) => void;
  /** Set by the form when submit found this required slot empty. */
  error?: string | null;
  disabled?: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The upload's own failure wins: it is the more recent, more specific thing
  // that just happened to this slot.
  const shownError = error ?? validationError ?? null;

  const pick = async (file: File) => {
    setUploading(true);
    setError(null);

    const form = new FormData();
    form.append("file", file, file.name);
    form.append("kind", kind);

    try {
      let res: Response;
      try {
        res = await fetch("/api/admin/buyback/vendors/uploads", {
          method: "POST",
          body: form,
        });
      } catch {
        throw new Error(
          "The upload could not reach the server — check your internet connection and try again.",
        );
      }

      const json = await res.json().catch(() => null);
      if (!json?.success) throw new Error(json?.error?.message ?? "Upload failed.");

      onChange({ documentId: json.data.document_id as string, fileName: file.name });
    } catch (e) {
      // Previous value stays — see file header.
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  return (
    // id + tabIndex so the form's focusFirstError can scroll to and focus an
    // un-attached required document the same way it does a text field.
    <div id={`doc-${kind}`} tabIndex={-1} className="flex flex-col gap-1.5 outline-none">
      <span className="text-xs font-semibold text-[color:var(--color-ink)]">
        {label}
        {required && <span style={{ color: "var(--color-danger)" }}> *</span>}
      </span>

      {/* One hidden input, reused by both the empty-state button and "Replace" —
          there is never a reason for two. */}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
        disabled={disabled}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void pick(file);
          // Reset, or picking the same file twice in a row fires no change event.
          e.target.value = "";
        }}
      />

      {uploading ? (
        <div className="flex items-center rounded-lg border border-dashed border-[color:var(--color-border)] bg-white px-3 py-2.5 text-sm text-[color:var(--color-ink-muted)]">
          Uploading…
        </div>
      ) : value ? (
        <div
          className="flex items-center gap-2 rounded-lg border px-3 py-2.5"
          style={{
            borderColor: "var(--color-success)",
            backgroundColor: "var(--color-success-bg)",
          }}
        >
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium"
            style={{ color: "var(--color-success)" }}
            title={value.fileName}
          >
            {value.fileName}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
            className="shrink-0 text-xs font-semibold hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            style={{ color: "var(--color-success)" }}
          >
            Replace
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          aria-describedby={`doc-${kind}-msg`}
          onClick={() => inputRef.current?.click()}
          className="flex w-full items-center rounded-lg border border-dashed px-3 py-2.5 text-left text-sm hover:border-[color:var(--color-brand-sky)] hover:text-[color:var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-50"
          style={
            shownError
              ? {
                  borderColor: "var(--color-danger)",
                  backgroundColor: "var(--color-danger-bg)",
                  color: "var(--color-danger)",
                }
              : {
                  borderColor: "var(--color-border)",
                  backgroundColor: "#fff",
                  color: "var(--color-ink-muted)",
                }
          }
        >
          ⇧ Upload {label}
        </button>
      )}

      {shownError ? (
        <span
          id={`doc-${kind}-msg`}
          role="alert"
          className="text-[11px] font-medium"
          style={{ color: "var(--color-danger)" }}
        >
          {shownError}
        </span>
      ) : (
        <span id={`doc-${kind}-msg`} className="text-[11px] text-[color:var(--color-ink-muted)]">
          PDF or image, up to 15 MB
        </span>
      )}
    </div>
  );
}
