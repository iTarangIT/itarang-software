"use client";

// Real image uploader for ASM visit photos. Files are uploaded to Supabase
// Storage via POST /api/uploads/dealer-documents (folder "visit-photos") and
// the returned public URLs are collected into a string[] — the exact shape
// the visit API already accepts (photos: z.array(z.string().url())).

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { ImagePlus, Loader2, X } from "lucide-react";

type Props = {
    value: string[];
    onChange: (urls: string[]) => void;
    max?: number;
    disabled?: boolean;
};

// Matches the allow-list enforced by /api/uploads/dealer-documents.
const ACCEPTED_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const UPLOAD_FOLDER = "visit-photos";

async function uploadOne(file: File): Promise<string> {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("folder", UPLOAD_FOLDER);
    const res = await fetch("/api/uploads/dealer-documents", {
        method: "POST",
        body: fd,
    });
    const json = await res.json();
    if (!res.ok || !json?.success) {
        throw new Error(json?.message ?? "Upload failed");
    }
    return String(json.file.url);
}

export function PhotoUploader({ value, onChange, max = 10, disabled }: Props) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [inFlight, setInFlight] = useState(0);
    const [dragOver, setDragOver] = useState(false);

    const atMax = value.length >= max;
    const busy = inFlight > 0;

    const handleFiles = useCallback(
        async (fileList: FileList | File[]) => {
            const incoming = Array.from(fileList);
            if (!incoming.length) return;

            const remaining = max - value.length;
            if (remaining <= 0) {
                toast.error(`You can attach at most ${max} photos.`);
                return;
            }

            const valid: File[] = [];
            for (const f of incoming) {
                if (!ACCEPTED_TYPES.includes(f.type)) {
                    toast.error(`${f.name}: only JPG, PNG or WEBP images are allowed.`);
                    continue;
                }
                valid.push(f);
            }

            const batch = valid.slice(0, remaining);
            if (valid.length > batch.length) {
                toast.message(`Only ${remaining} more photo(s) can be added.`);
            }
            if (!batch.length) return;

            const uploaded: string[] = [];
            for (const file of batch) {
                setInFlight((n) => n + 1);
                try {
                    uploaded.push(await uploadOne(file));
                } catch (err) {
                    toast.error((err as Error).message);
                } finally {
                    setInFlight((n) => n - 1);
                }
            }
            if (uploaded.length) {
                onChange([...value, ...uploaded]);
                toast.success(
                    `${uploaded.length} photo${uploaded.length > 1 ? "s" : ""} uploaded.`,
                );
            }
        },
        [max, value, onChange],
    );

    const removeAt = (index: number) =>
        onChange(value.filter((_, i) => i !== index));

    return (
        <div>
            <input
                ref={inputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                className="hidden"
                onChange={(e) => {
                    if (e.target.files) void handleFiles(e.target.files);
                    if (inputRef.current) inputRef.current.value = "";
                }}
            />

            <button
                type="button"
                disabled={disabled || atMax || busy}
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => {
                    e.preventDefault();
                    if (!disabled && !atMax && !busy) setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    if (disabled || atMax || busy) return;
                    if (e.dataTransfer.files) void handleFiles(e.dataTransfer.files);
                }}
                className={`flex w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed px-3 py-4 text-sm transition ${
                    dragOver
                        ? "border-emerald-400 bg-emerald-50 text-emerald-700"
                        : "border-gray-300 bg-white text-gray-500 hover:border-gray-400 hover:text-gray-700"
                } disabled:cursor-not-allowed disabled:opacity-60`}
            >
                {busy ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                    <ImagePlus className="h-5 w-5" />
                )}
                <span>
                    {busy
                        ? `Uploading ${inFlight} photo${inFlight > 1 ? "s" : ""}…`
                        : atMax
                            ? `Photo limit reached (${max})`
                            : "Drag & drop photos here, or click to choose"}
                </span>
                <span className="text-[11px] text-gray-400">
                    JPG, PNG or WEBP · up to 10 MB each
                </span>
            </button>

            {value.length > 0 && (
                <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {value.map((url, i) => (
                        <div
                            key={`${url}-${i}`}
                            className="group relative aspect-square overflow-hidden rounded-md border border-gray-200 bg-gray-50"
                        >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={url}
                                alt={`Visit photo ${i + 1}`}
                                className="h-full w-full object-cover"
                            />
                            {!disabled && (
                                <button
                                    type="button"
                                    onClick={() => removeAt(i)}
                                    aria-label="Remove photo"
                                    className="absolute right-1 top-1 rounded-full bg-black/55 p-0.5 text-white opacity-0 transition group-hover:opacity-100 hover:bg-black/75"
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
