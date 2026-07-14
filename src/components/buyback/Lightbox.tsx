"use client";

/**
 * Full-size evidence viewer (M03: "admin per-line zoom lightbox").
 *
 * Used by BOTH the dealer's intake page and the admin's review screen — the same
 * component, because they are looking at the same thing for the same reason.
 *
 * Loads the FULL-SIZE original, not the thumbnail. The point of opening a battery
 * photo is to look closely at it: the admin is checking whether a cell is swollen
 * or a terminal is corroded, and a 1024px preview blurred up to fill a screen
 * would defeat the entire purpose of having asked for the photo.
 *
 * Everything is served through /api/buyback/media, which re-checks entitlement on
 * every single request. The S3 key never reaches the browser.
 */

import { useEffect, useState } from "react";

export interface LightboxItem {
  /** For a battery photo. */
  photoId?: string;
  /** For a provenance document. */
  provenanceId?: string;
  field?: "id_proof" | "purchase_proof";
  /** Shown above the image, e.g. "60V 120Ah · Working — photo 2 of 6". */
  caption?: string;
  /** A PDF cannot be shown in an <img>. */
  isPdf?: boolean;
}

export function mediaUrl(item: LightboxItem, size: "thumb" | "full" = "thumb"): string {
  if (item.photoId) {
    return `/api/buyback/media?photo=${item.photoId}&size=${size}`;
  }
  return `/api/buyback/media?provenance=${item.provenanceId}&field=${item.field}`;
}

export default function Lightbox({
  items,
  index,
  onClose,
  onIndex,
}: {
  items: LightboxItem[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
}) {
  // Which images have finished loading, by index. A plain `loading` boolean would
  // need an effect to reset it when the user arrows to the next photo — and a
  // setState inside an effect is a cascading render. Tracking what has loaded is
  // the same information without the effect, and it also stops the spinner
  // flashing when you arrow BACK to a photo the browser has already cached.
  const [loaded, setLoaded] = useState<Set<number>>(() => new Set());

  const item = items[index];
  const many = items.length > 1;
  const loading = !loaded.has(index);

  // Escape closes; arrows move. An image viewer without these feels broken, and a
  // reviewer working through twenty photos should never have to reach for a mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (!many) return;
      if (e.key === "ArrowRight") onIndex((index + 1) % items.length);
      if (e.key === "ArrowLeft") onIndex((index - 1 + items.length) % items.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, many, onClose, onIndex]);

  if (!item) return null;

  const markLoaded = () => setLoaded((s) => (s.has(index) ? s : new Set(s).add(index)));

  const src = mediaUrl(item, "full");

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-slate-950/90 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="flex items-center justify-between px-5 py-3 text-white">
        <div className="text-sm">
          {item.caption}
          {many && (
            <span className="ml-2 text-white/50">
              {index + 1} / {items.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="rounded-lg border border-white/20 px-3 py-1.5 text-xs font-semibold hover:bg-white/10"
          >
            Open original
          </a>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg border border-white/20 px-3 py-1.5 text-xs font-semibold hover:bg-white/10"
          >
            Close ✕
          </button>
        </div>
      </div>

      <div
        className="relative flex flex-1 items-center justify-center overflow-hidden px-4 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        {many && (
          <button
            onClick={() => onIndex((index - 1 + items.length) % items.length)}
            aria-label="Previous"
            className="absolute left-4 z-10 rounded-full bg-white/10 px-3 py-3 text-white hover:bg-white/20"
          >
            ‹
          </button>
        )}

        {item.isPdf ? (
          // A PDF is a document, not a picture. Embedding it beats a download: an
          // admin checking an ID proof wants to glance at it, not manage a file.
          <iframe src={src} title={item.caption ?? "Document"} className="h-full w-full rounded-lg bg-white" />
        ) : (
          <>
            {loading && (
              <div className="absolute text-sm text-white/60">Loading full size…</div>
            )}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={index}
              src={src}
              alt={item.caption ?? "Evidence"}
              onLoad={markLoaded}
              // Also clear on error, or a broken image leaves "Loading full size…"
              // on screen forever, which reads as a hang rather than a failure.
              onError={markLoaded}
              className={`max-h-full max-w-full rounded-lg object-contain transition-opacity ${
                loading ? "opacity-0" : "opacity-100"
              }`}
            />
          </>
        )}

        {many && (
          <button
            onClick={() => onIndex((index + 1) % items.length)}
            aria-label="Next"
            className="absolute right-4 z-10 rounded-full bg-white/10 px-3 py-3 text-white hover:bg-white/20"
          >
            ›
          </button>
        )}
      </div>
    </div>
  );
}
