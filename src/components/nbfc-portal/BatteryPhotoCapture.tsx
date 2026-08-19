"use client";

/**
 * Photograph capture for a recovered battery — BRD §20.
 *
 * THE BUG THIS CLOSES
 *   The dealer lot page renders a gallery headed "Photographs · captured at
 *   inspection". No screen in the product had ever uploaded one. The upload
 *   route existed (`POST /api/nbfc/recovery/batteries/[id]/photos`, complete
 *   with format guards) and had zero callers, so that gallery was structurally
 *   guaranteed to be empty for every lot ever published. Dealers were being
 *   asked to bid on a battery they could not see.
 *
 * WHY A PLAIN <label> AND NOT A DROPZONE
 *   `accept="image/*"` on a file input is what makes mobile Safari and Chrome
 *   offer "Take Photo" — which is how these pictures are actually taken, on a
 *   phone, at the collection centre. A drag-and-drop surface is desktop
 *   furniture that would not help the person doing the job.
 *
 * WHY SAME-ORIGIN MULTIPART AND NOT A PRESIGNED PUT
 *   The bucket has no CORS rules, so a cross-origin PUT from the browser dies
 *   as a bare `TypeError: Failed to fetch`. The buyback uploader learned this
 *   the hard way and posts to its own origin; so does this.
 */
import { useRef, useState } from "react";
import { toast } from "sonner";

/** BRD §20 — the five angles a bidder needs to judge a battery. */
const SLOTS = [
  { key: "front", label: "Front" },
  { key: "back", label: "Back" },
  { key: "side", label: "Side" },
  { key: "serial", label: "Serial plate" },
  { key: "damage", label: "Damage" },
] as const;

const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPTED = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];

interface Props {
  batteryId: string;
  /** Photos already on the battery. */
  initialUrls?: string[];
  onChange?: (urls: string[]) => void;
}

export default function BatteryPhotoCapture({
  batteryId,
  initialUrls = [],
  onChange,
}: Props) {
  const [urls, setUrls] = useState<string[]>(initialUrls);
  const [uploading, setUploading] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const objectUrl = useRef<string | null>(null);

  function releasePreview() {
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
    setPreview(null);
  }

  async function upload(file: File, label: string) {
    if (!ACCEPTED.includes(file.type)) {
      toast.error(
        `${file.type || "That file"} is not an image the gallery can render — use JPEG, PNG, WebP or HEIC.`,
      );
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("That image is over 25 MB. Take it again at a lower quality.");
      return;
    }

    // Local preview while the bytes are in flight, so the operator sees the
    // shot land immediately rather than staring at a spinner.
    releasePreview();
    objectUrl.current = URL.createObjectURL(file);
    setPreview(objectUrl.current);
    setUploading(label);

    try {
      const form = new FormData();
      form.append("file", file);
      form.append("label", label);

      // Not `nbfcFetch`: FormData must set its own multipart boundary, and that
      // helper adds a JSON content-type when a body is present.
      const res = await fetch(
        `/api/nbfc/recovery/batteries/${batteryId}/photos`,
        { method: "POST", body: form },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        const raw = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
        // The 409 is worth spelling out: it is an environment problem, not
        // something the operator did wrong, and it will happen to every photo.
        if (res.status === 409) {
          throw new Error(
            "Photo storage is not configured on this environment (STORAGE_BACKEND must be s3). Nothing was saved.",
          );
        }
        throw new Error(raw.replace(/^[A-Z_]+:\s*/, ""));
      }

      const next: string[] = body.image_urls ?? [];
      setUrls(next);
      onChange?.(next);
      toast.success(`${label} photo added`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      releasePreview();
      setUploading(null);
    }
  }

  const filled = urls.length;

  return (
    <div className="auc-field">
      <span className="auc-label">
        Photographs · {filled} of {SLOTS.length}
      </span>

      <div className="auc-shots">
        {urls.map((url, i) => (
          <div key={url} className="auc-thumb">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={`Battery photo ${i + 1}`}
              onClick={() => setLightbox(url)}
              style={{ cursor: "zoom-in" }}
            />
          </div>
        ))}

        {preview ? (
          <div className="auc-thumb" data-uploading="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt="Uploading" />
            <span className="auc-thumb-label">uploading…</span>
          </div>
        ) : null}

        {SLOTS.slice(filled).map((slot) => (
          <label key={slot.key} className="auc-drop">
            <span>{slot.label}</span>
            <span aria-hidden="true">＋</span>
            <input
              type="file"
              accept="image/*"
              disabled={uploading !== null}
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Reset so re-picking the same file fires `change` again.
                e.target.value = "";
                if (f) void upload(f, slot.key);
              }}
            />
          </label>
        ))}
      </div>

      <span className="auc-hint">
        Captured once, here, and reused verbatim as the auction images — never
        re-uploaded later. Front, back, side, the serial plate and any damage is
        what a dealer needs to bid without seeing the battery.
      </span>

      {lightbox ? (
        <div
          className="auc-lightbox"
          role="dialog"
          aria-modal="true"
          onClick={() => setLightbox(null)}
        >
          <button
            type="button"
            className="auc-lightbox-x"
            onClick={() => setLightbox(null)}
          >
            Close
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="Battery photograph" />
        </div>
      ) : null}
    </div>
  );
}
