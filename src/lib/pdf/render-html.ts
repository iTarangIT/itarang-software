/**
 * HTML → PDF, on the pooled browser.
 *
 * This exact function was copy-pasted into four call sites before this file
 * existed (kyc/consent-service, lead/profile-export, the dealer-verification
 * audit trail, and the Digio agreement route). They are left alone — changing
 * four live document pipelines is not this sprint's business — but nothing new
 * should add a fifth copy, so buyback's quotations and POs render through here.
 *
 * `launchBrowser()` is self-healing and pooled: it prefers the system Chrome at
 * PUPPETEER_EXECUTABLE_PATH (which both the sandbox and production pm2 configs
 * pin), falls back to @sparticuz/chromium, then to a local puppeteer. The page
 * is always closed; the browser is not, deliberately — it is shared.
 */

import { launchBrowser } from "./launch-browser";

export interface RenderPdfOptions {
  /** Defaults to A4 portrait with 10mm margins — the house style of the other four. */
  format?: "A4" | "Letter";
  landscape?: boolean;
  margin?: { top: string; right: string; bottom: string; left: string };
}

const DEFAULT_MARGIN = { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" };

export async function renderPdfFromHtml(
  html: string,
  options: RenderPdfOptions = {},
): Promise<Buffer> {
  const browser = await launchBrowser();
  const page = await browser.newPage();

  try {
    // domcontentloaded, not networkidle: every buyback template is fully
    // self-contained (photos are inlined as data: URIs before we get here), so
    // waiting on the network would only ever wait for nothing.
    await page.setContent(html, { waitUntil: "domcontentloaded" });

    const pdf = await page.pdf({
      format: options.format ?? "A4",
      landscape: options.landscape ?? false,
      printBackground: true,
      margin: options.margin ?? DEFAULT_MARGIN,
    });

    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
  }
}

export interface RenderPngOptions {
  /** Card width in CSS pixels. Default suits a phone-shaped share image. */
  width?: number;
  /** Floor for the capture height; the content normally exceeds it. */
  minHeight?: number;
  /**
   * Retina factor. 2 doubles the pixel count for the same layout — worth it for
   * a card that will be pinch-zoomed in a chat app, where 1x text looks soft.
   */
  deviceScaleFactor?: number;
}

/**
 * HTML → PNG, on the same pooled browser as renderPdfFromHtml.
 *
 * `fullPage` so the card is never cropped by the viewport: the height below is
 * only a starting box, and the real height comes from the content. The page is
 * closed; the browser is NOT, deliberately — it is shared with the PDF
 * pipelines, and re-launching Chromium per call on a box that also runs
 * production would be the expensive way to do this.
 */
export async function renderPngFromHtml(
  html: string,
  options: RenderPngOptions = {},
): Promise<Buffer> {
  const browser = await launchBrowser();
  const page = await browser.newPage();

  try {
    // A deliberately SHORT viewport. `fullPage` captures max(viewport, content),
    // so a tall viewport pads a shorter card with dead space at the bottom —
    // which in a chat app is a thumbnail that looks half-empty. Starting small
    // lets the content decide the height.
    await page.setViewport({
      width: options.width ?? 720,
      height: options.minHeight ?? 200,
      deviceScaleFactor: options.deviceScaleFactor ?? 2,
    });

    // Self-contained markup (inline styles, no external fonts or images), so
    // there is never anything on the network to wait for.
    await page.setContent(html, { waitUntil: "domcontentloaded" });

    const png = await page.screenshot({ type: "png", fullPage: true });

    return Buffer.from(png);
  } finally {
    await page.close().catch(() => {});
  }
}
