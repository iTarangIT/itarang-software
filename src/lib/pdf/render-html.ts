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
