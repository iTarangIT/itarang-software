/**
 * Puppeteer launcher that works in both local/dev (system Chrome via `puppeteer`)
 * and serverless runtimes (Vercel/AWS Lambda, via `puppeteer-core` +
 * `@sparticuz/chromium-min`).
 *
 * @sparticuz/chromium-min is a JS shim that fetches the Chromium binary from
 * GitHub at cold-start, keeping the serverless bundle well under Vercel's
 * 50 MB zipped limit. The remote-pack URL must match the installed
 * @sparticuz/chromium-min version.
 */

const CHROMIUM_REMOTE_PACK =
  "https://github.com/Sparticuz/chromium/releases/download/v147.0.0/chromium-v147.0.0-pack.x64.tar";

export async function launchBrowser() {
  // Use the self-contained @sparticuz/chromium-min bundle on Vercel/Lambda, or
  // whenever USE_SPARTICUZ_CHROMIUM=1 is set (opt-in for VPS/Hostinger where
  // the system Chromium is missing libatk / libgbm / libnss and we can't
  // sudo apt-get install).
  const isServerless =
    !!process.env.VERCEL ||
    !!process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.USE_SPARTICUZ_CHROMIUM === "1";

  if (isServerless) {
    const [{ default: puppeteerCore }, { default: chromium }] = await Promise.all([
      import("puppeteer-core"),
      import("@sparticuz/chromium-min"),
    ]);
    return puppeteerCore.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(CHROMIUM_REMOTE_PACK),
      headless: true,
    });
  }

  const { default: puppeteer } = await import("puppeteer");
  return puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}

