"use client";

// Reusable file-upload control. Pick a file → it uploads to Supabase Storage
// via POST /api/uploads/dealer-documents → the public URL is captured. Used by
// the Update Commercials modal in place of pasted document URLs.

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Paperclip, UploadCloud, X } from "lucide-react";
import { Label } from "@/components/ui/label";

type Props = {
    label: string;
    value: string;
    fileName?: string;
    folder: string;
    onChange: (url: string, fileName: string) => void;
    disabled?: boolean;
    accept?: string;
};

const ACCEPT_DEFAULT = ".pdf,.jpg,.jpeg,.png,.webp";

// Derive a readable name from a stored URL — strips the "<ts>-<uuid>-" prefix
// the upload route prepends, for rows saved before a filename was tracked.
function nameFromUrl(url: string): string {
    try {
        const last = decodeURIComponent(
            new URL(url).pathname.split("/").pop() ?? "",
        );
        return (
            last.replace(/^\d+-[0-9a-f-]{36}-/i, "") || "Uploaded document"
        );
    } catch {
        return "Uploaded document";
    }
}

export function FileUploadField({
    label,
    value,
    fileName,
    folder,
    onChange,
    disabled,
    accept = ACCEPT_DEFAULT,
}: Props) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);

    const handleFile = async (file: File | undefined | null) => {
        if (!file) return;
        setUploading(true);
        try {
            const fd = new FormData();
            fd.append("file", file);
            fd.append("folder", folder);
            const res = await fetch("/api/uploads/dealer-documents", {
                method: "POST",
                body: fd,
            });
            const json = await res.json();
            if (!res.ok || !json?.success) {
                throw new Error(json?.message ?? "Upload failed");
            }
            onChange(String(json.file.url), String(json.file.name));
            toast.success(`${json.file.name} uploaded.`);
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setUploading(false);
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    const displayName = value ? fileName || nameFromUrl(value) : "";

    return (
        <div>
            <Label>{label}</Label>
            <input
                ref={inputRef}
                type="file"
                accept={accept}
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
            />
            {value ? (
                <div className="mt-1 flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2">
                    <Paperclip className="h-4 w-4 shrink-0 text-gray-400" />
                    <a
                        href={value}
                        target="_blank"
                        rel="noreferrer"
                        className="flex-1 truncate text-sm text-blue-700 hover:underline"
                    >
                        {displayName}
                    </a>
                    {!disabled && (
                        <>
                            <button
                                type="button"
                                onClick={() => inputRef.current?.click()}
                                disabled={uploading}
                                className="text-xs font-medium text-gray-500 hover:text-gray-900 disabled:opacity-60"
                            >
                                {uploading ? "Uploading…" : "Replace"}
                            </button>
                            <button
                                type="button"
                                onClick={() => onChange("", "")}
                                disabled={uploading}
                                aria-label="Remove file"
                                className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-red-600 disabled:opacity-60"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </>
                    )}
                </div>
            ) : (
                <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    disabled={disabled || uploading}
                    className="mt-1 flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-500 hover:border-gray-400 hover:text-gray-700 disabled:opacity-60"
                >
                    {uploading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <UploadCloud className="h-4 w-4" />
                    )}
                    {uploading ? "Uploading…" : "Choose file (PDF or image)"}
                </button>
            )}
        </div>
    );
}
