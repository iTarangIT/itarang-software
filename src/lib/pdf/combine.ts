/**
 * Combine multiple documents (PDFs + images) into a single PDF — the Step-4
 * "combine & upload as one PDF" feature (counts as one bucket item).
 *
 * PDFs are appended page-for-page; images are normalised to PNG via `sharp`
 * (handles jpg/webp/heic/etc.) and drawn full-bleed on a page sized to the image.
 * Only image/PDF inputs are combinable — the caller must filter out video/zip.
 *
 * Server-only (pdf-lib + sharp are not bundled for the browser).
 */
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

export interface CombineInput {
  buffer: Buffer;
  type: string;
  name: string;
}

function isPdf(type: string, name: string): boolean {
  return type === "application/pdf" || /\.pdf$/i.test(name);
}
function isImage(type: string, name: string): boolean {
  return (
    type.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif)$/i.test(name)
  );
}

export function isCombinable(type: string, name: string): boolean {
  return isPdf(type, name) || isImage(type, name);
}

export async function combineToPdf(files: CombineInput[]): Promise<Buffer> {
  const merged = await PDFDocument.create();

  for (const f of files) {
    if (isPdf(f.type, f.name)) {
      const src = await PDFDocument.load(f.buffer, { ignoreEncryption: true });
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    } else if (isImage(f.type, f.name)) {
      // Normalise any raster format to PNG so pdf-lib can embed it.
      const pngBytes = await sharp(f.buffer).png().toBuffer();
      const img = await merged.embedPng(pngBytes);
      const page = merged.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    } else {
      throw new Error(`Cannot combine '${f.name}' — only images and PDFs.`);
    }
  }

  const bytes = await merged.save();
  return Buffer.from(bytes);
}
