"use client";

import { useRef, useState } from "react";
import { AlertTriangle, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const MAX_MB = 15;
const ACCEPT = "image/jpeg,image/png,image/gif,image/webp";

export function AddMediaDialog({
    productId,
    hasExistingMedia,
    onClose,
    onAdded,
}: {
    productId: string;
    hasExistingMedia: boolean;
    onClose: () => void;
    onAdded: () => void;
}) {
    const fileRef = useRef<HTMLInputElement>(null);
    const [mode, setMode] = useState<"file" | "url">("file");
    const [url, setUrl] = useState("");
    // Only offered when there is already a thumbnail; otherwise Hostinger makes
    // the first image primary anyway and the choice would be noise.
    const [isThumbnail, setIsThumbnail] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            let res: Response;
            if (mode === "file") {
                const f = fileRef.current?.files?.[0];
                if (!f) throw new Error("Choose an image first");
                const form = new FormData();
                form.append("file", f);
                if (isThumbnail) form.append("isThumbnail", "true");
                res = await fetch(`/api/ecommerce/products/${productId}/images`, {
                    method: "POST",
                    body: form,
                });
            } else {
                res = await fetch(`/api/ecommerce/products/${productId}/images`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        imageUrl: url.trim(),
                        ...(isThumbnail ? { isThumbnail: true } : {}),
                    }),
                });
            }
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error(body?.error?.message ?? "Upload failed");
            onAdded();
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Upload failed");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md space-y-4 rounded-xl border border-border bg-surface p-5 shadow-card">
                <div className="flex items-start justify-between gap-3">
                    <h2 className="text-lg font-semibold text-ink">Add media</h2>
                    <button onClick={onClose} className="text-ink-muted hover:text-ink" aria-label="Close">
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="rounded-lg border border-border bg-bg/50 px-3 py-2 text-xs text-ink-muted">
                    Images can be <strong className="text-ink">added</strong> from here but not
                    removed or reordered — Hostinger&apos;s API provides no endpoint for either.
                    Use the Hostinger dashboard for that.
                </div>

                <div className="flex gap-2">
                    <Button size="sm" variant={mode === "file" ? "primary" : "outline"} onClick={() => setMode("file")}>
                        Upload file
                    </Button>
                    <Button size="sm" variant={mode === "url" ? "primary" : "outline"} onClick={() => setMode("url")}>
                        From URL
                    </Button>
                </div>

                {mode === "file" ? (
                    <div className="space-y-1.5">
                        <Label htmlFor="file">Image file</Label>
                        <input
                            id="file"
                            ref={fileRef}
                            type="file"
                            accept={ACCEPT}
                            className="block w-full text-sm text-ink file:mr-3 file:rounded-lg file:border file:border-border file:bg-bg file:px-3 file:py-1.5 file:text-sm file:text-ink"
                        />
                        <p className="text-xs text-ink-muted">
                            JPEG, PNG, GIF or WebP, up to {MAX_MB} MB. SVG is not accepted by
                            Hostinger.
                        </p>
                    </div>
                ) : (
                    <div className="space-y-1.5">
                        <Label htmlFor="url">Image URL</Label>
                        <Input
                            id="url"
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder="https://..."
                        />
                        <p className="text-xs text-ink-muted">
                            Must be publicly reachable — Hostinger fetches it directly.
                        </p>
                    </div>
                )}

                {hasExistingMedia ? (
                    <label className="flex items-center gap-2 text-sm text-ink">
                        <input
                            type="checkbox"
                            checked={isThumbnail}
                            onChange={(e) => setIsThumbnail(e.target.checked)}
                        />
                        Make this the primary image
                    </label>
                ) : null}

                {error ? (
                    <div className="flex items-start gap-2 rounded-lg bg-danger-bg/50 px-3 py-2 text-sm text-danger">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        {error}
                    </div>
                ) : null}

                <div className="flex gap-2">
                    <Button disabled={busy || (mode === "url" && !url.trim())} onClick={submit}>
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                        Add image
                    </Button>
                    <Button variant="outline" onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                </div>
            </div>
        </div>
    );
}
