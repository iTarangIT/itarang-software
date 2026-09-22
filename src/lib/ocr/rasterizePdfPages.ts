/**
 * Render a PDF's pages to PNG for a vision model to read.
 *
 * Sibling of rasterizePdfFirstPage (./pdfToImage.ts) for documents whose
 * figures can land on a later page — a long sales invoice puts its totals on
 * page 2. Same mupdf (pure WASM) renderer.
 *
 * `strips` additionally cuts each page into that many overlapping horizontal
 * bands. A vision model downscales every image to a fixed budget, so on a whole
 * A4 page small print (a letterhead GSTIN, a taxable-amount table) comes
 * through too blurred to read; a quarter-page band keeps its full resolution.
 * The overlap means no line of text is only ever seen cut in half.
 *
 * mupdf is loaded with a dynamic import rather than a static one: it is
 * ESM-only with top-level await, and a static import breaks every tsx-run
 * script that reaches this module (they are transformed to CommonJS). A bare
 * `import("mupdf")` is handed to Node's own ESM loader and works in both the
 * Next.js server and those scripts.
 *
 * Throws on a document mupdf cannot open or that has no pages — the caller
 * must not fall back to guessing.
 */
export interface RenderedPdfPage {
  /** The whole page. */
  page: Buffer;
  /** Top-to-bottom bands of the same page, at the same resolution. */
  strips: Buffer[];
}

/** Share of a strip's height repeated in the next one. */
const STRIP_OVERLAP = 0.15;

export async function rasterizePdfPages(
  buffer: Buffer,
  opts: { dpi?: number; maxPages?: number; strips?: number } = {},
): Promise<RenderedPdfPage[]> {
  const dpi = opts.dpi ?? 200;
  const maxPages = opts.maxPages ?? 4;
  const strips = opts.strips ?? 0;
  const mupdf = await import("mupdf");
  const matrix = mupdf.Matrix.scale(dpi / 72, dpi / 72);

  const doc = mupdf.Document.openDocument(buffer, "application/pdf");
  try {
    const count = doc.countPages();
    if (count < 1) throw new Error("PDF has no pages");

    const out: RenderedPdfPage[] = [];
    for (let i = 0; i < Math.min(count, maxPages); i++) {
      const page = doc.loadPage(i);
      try {
        const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
        let whole: Buffer;
        try {
          whole = Buffer.from(pixmap.asPNG());
        } finally {
          pixmap.destroy();
        }

        const bands: Buffer[] = [];
        if (strips > 0) {
          const [x0, y0, x1, y1] = page.getBounds();
          const height = y1 - y0;
          // n strips of height h, each starting (1 - overlap)·h below the last,
          // spanning the page exactly: h + (n - 1)(1 - overlap)h = height.
          const h = height / (1 + (strips - 1) * (1 - STRIP_OVERLAP));
          for (let s = 0; s < strips; s++) {
            const top = y0 + s * (1 - STRIP_OVERLAP) * h;
            bands.push(renderRegion(mupdf, page, matrix, [x0, top, x1, Math.min(y1, top + h)]));
          }
        }
        out.push({ page: whole, strips: bands });
      } finally {
        page.destroy();
      }
    }
    return out;
  } finally {
    // Free WASM-side allocations so a long-running scan does not leak memory.
    doc.destroy();
  }
}

/** Draw one rectangle of a page: a pixmap sized to it clips the render. */
function renderRegion(
  mupdf: typeof import("mupdf"),
  page: import("mupdf").Page,
  matrix: import("mupdf").Matrix,
  rect: import("mupdf").Rect,
): Buffer {
  const [bx0, by0, bx1, by1] = mupdf.Rect.transform(rect, matrix);
  const band = new mupdf.Pixmap(
    mupdf.ColorSpace.DeviceRGB,
    [Math.floor(bx0), Math.floor(by0), Math.ceil(bx1), Math.ceil(by1)],
    false,
  );
  try {
    band.clear(255);
    const device = new mupdf.DrawDevice(matrix, band);
    try {
      page.run(device, mupdf.Matrix.identity);
      device.close();
    } finally {
      device.destroy();
    }
    return Buffer.from(band.asPNG());
  } finally {
    band.destroy();
  }
}
