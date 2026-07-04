import * as mupdf from "mupdf";

/**
 * Detect whether a fetched document is a PDF. KYC docs can be uploaded as
 * either images or PDFs; OCR (Decentro + Tesseract) only understands image
 * bytes, so the caller must rasterize PDFs first.
 *
 * Checks the HTTP content-type and falls back to a `.pdf` extension on the
 * file name / URL, since storage backends don't always return a precise type.
 */
export function isPdf(contentType?: string | null, nameOrUrl?: string | null): boolean {
    if (contentType && contentType.toLowerCase().includes("application/pdf")) return true;
    if (nameOrUrl && /\.pdf($|\?)/i.test(nameOrUrl)) return true;
    return false;
}

/**
 * Rasterize the first page of a PDF to a PNG buffer using mupdf (pure WASM,
 * no system libraries — same deployment model as the tesseract.js wasm
 * worker). Page 1 is sufficient for single-page KYC docs (PAN, Aadhaar,
 * cheque); multi-page bank statements are OCR'd best-effort on page 1.
 *
 * @param buffer Raw PDF bytes.
 * @param dpi    Render resolution. 200 DPI gives OCR-quality text without
 *               producing an excessively large bitmap.
 */
export async function rasterizePdfFirstPage(buffer: Buffer, dpi = 200): Promise<Buffer> {
    let doc: mupdf.Document | undefined;
    let page: mupdf.Page | undefined;
    let pixmap: mupdf.Pixmap | undefined;
    try {
        doc = mupdf.Document.openDocument(buffer, "application/pdf");
        if (doc.countPages() < 1) {
            throw new Error("PDF has no pages");
        }
        page = doc.loadPage(0);
        const scale = dpi / 72;
        pixmap = page.toPixmap(
            mupdf.Matrix.scale(scale, scale),
            mupdf.ColorSpace.DeviceRGB,
            false,
        );
        return Buffer.from(pixmap.asPNG());
    } finally {
        // Free WASM-side allocations so a long-running server process doesn't
        // leak memory across OCR calls.
        try { pixmap?.destroy(); } catch { /* noop */ }
        try { page?.destroy(); } catch { /* noop */ }
        try { doc?.destroy(); } catch { /* noop */ }
    }
}
