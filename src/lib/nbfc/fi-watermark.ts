/**
 * FI photo watermark — BRD Addendum V0.3.1 §10.7.
 *
 * iTarang renders a VISIBLE watermark with lat/long + server timestamp on each
 * field photo before upload; the structured GPS/timestamp is also stored in the
 * DB. This is corroboration, not courtroom proof (GPS spoofing is possible on
 * rooted devices) — but watermark + server-timestamp + distance-to-address
 * together raise the bar. Uses `sharp` (already a dependency).
 *
 * Never throws: if watermarking fails (odd format, decode error) we return the
 * original bytes with `applied:false` so the upload still proceeds and the
 * Review screen surfaces a "missing watermark" auto-flag (§10.8.1).
 */
import sharp from "sharp";

export interface WatermarkMeta {
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  /** Server timestamp at form-open GPS capture (authoritative). */
  timestamp: Date;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function watermarkPhoto(
  input: Buffer,
  meta: WatermarkMeta,
): Promise<{ buffer: Buffer; applied: boolean }> {
  try {
    // Normalise orientation (mobile photos carry EXIF rotation) then re-encode.
    const base = sharp(input).rotate();
    const info = await base.metadata();
    const width = info.width ?? 1080;
    const height = info.height ?? 1080;

    const gps =
      meta.lat != null && meta.lng != null
        ? `${meta.lat.toFixed(6)}, ${meta.lng.toFixed(6)}${meta.accuracyM != null ? ` ±${Math.round(meta.accuracyM)}m` : ""}`
        : "GPS unavailable";
    const ts = meta.timestamp.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

    const band = Math.max(48, Math.round(height * 0.07));
    const fontSize = Math.max(16, Math.round(band * 0.32));
    const pad = Math.round(band * 0.22);

    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="${height - band}" width="${width}" height="${band}" fill="rgba(15,23,42,0.62)"/>
        <text x="${pad}" y="${height - band + fontSize + pad / 2}" font-family="Arial, sans-serif"
          font-size="${fontSize}" fill="#ffffff" font-weight="600">iTarang FI &#8226; ${esc(gps)}</text>
        <text x="${pad}" y="${height - pad}" font-family="Arial, sans-serif"
          font-size="${Math.round(fontSize * 0.82)}" fill="#e2e8f0">${esc(ts)} IST</text>
      </svg>`;

    const out = await base
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 82 })
      .toBuffer();
    return { buffer: out, applied: true };
  } catch {
    return { buffer: input, applied: false };
  }
}
