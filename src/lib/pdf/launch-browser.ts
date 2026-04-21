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

// Extra Chromium flags that skip work we don't need for one-shot PDF rendering
// (audio, GPU, shared-memory, translation, background tasks). Shaves ~1-2s off
// cold-start and ~200-500ms off steady-state render time.
const FAST_FLAGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-breakpad",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-translate",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
  "--hide-scrollbars",
  "--metrics-recording-only",
];

// Long-lived browser per Node process — launching Chromium is the most
// expensive step (1-3s locally, 5-10s cold on serverless). Reusing it across
// requests on the same warm instance makes subsequent renders near-instant.
// On serverless cold starts this falls back to launching once per container.
type BrowserHandle = Awaited<ReturnType<typeof launchBrowserOnce>>;
let browserPromise: Promise<BrowserHandle> | null = null;

async function launchBrowserOnce() {
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
      args: [...chromium.args, ...FAST_FLAGS],
      defaultViewport: (chromium as unknown as { defaultViewport?: unknown }).defaultViewport as never,
      executablePath: await chromium.executablePath(CHROMIUM_REMOTE_PACK),
      headless: true,
    });
  }

  const { default: puppeteer } = await import("puppeteer");
  return puppeteer.launch({ headless: true, args: FAST_FLAGS });
}

export async function launchBrowser() {
  if (browserPromise) {
    try {
      const existing = await browserPromise;
      // Guard against a crashed/closed browser from a previous request.
      const connected = (existing as unknown as { isConnected?: () => boolean })
        .isConnected?.() ?? true;
      if (connected) return existing;
    } catch {
      // fall through and re-launch
    }
    browserPromise = null;
  }
  browserPromise = launchBrowserOnce();
  browserPromise.catch(() => {
    browserPromise = null;
  });
  return browserPromise;
}

