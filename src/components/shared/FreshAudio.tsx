"use client";

// A call-recording player that asks for a fresh 15-minute link when Play is
// pressed (tracker ID 166: "the player asks for a fresh link on Play"). A
// recording in our storage shows a Play button first; the link is fetched for
// this user (GET /api/files/link, same file rule as the opener) and the audio
// starts. Anything else (a provider link not yet copied) plays as before.

import { useState, type AudioHTMLAttributes } from "react";
import { Play } from "lucide-react";

import { freshFileUrl, isStoredFileUrl } from "@/lib/storage/freshFileLink";

type Props = Omit<AudioHTMLAttributes<HTMLAudioElement>, "src"> & { src: string | null | undefined };

export default function FreshAudio({ src, className, ...rest }: Props) {
    const stored = isStoredFileUrl(src);
    const [url, setUrl] = useState<string | null>(stored ? null : (src ?? null));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!src) return null;

    if (!url) {
        return (
            <div className={className}>
                <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                        setBusy(true);
                        setError(null);
                        try {
                            setUrl(await freshFileUrl(src));
                        } catch (err) {
                            setError(err instanceof Error ? err.message : "You can't play this recording.");
                        } finally {
                            setBusy(false);
                        }
                    }}
                    className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                >
                    <Play className="h-3.5 w-3.5" />
                    {busy ? "Loading…" : "Play recording"}
                </button>
                {error && <p className="mt-1 text-[11px] text-rose-600">{error}</p>}
            </div>
        );
    }

    // autoPlay: the person already pressed Play once to fetch the link.
    return <audio {...rest} controls autoPlay={stored} src={url} className={className} />;
}
