/**
 * Puppeteer launcher that works in both local/dev (system Chrome via `puppeteer`)
 * and serverless runtimes (Vercel/AWS Lambda, via `puppeteer-core` +
 * `@sparticuz/chromium`).
 *
 * We use the full `@sparticuz/chromium` package (not `-min`) so the binary
 * ships in node_modules with proper +x permissions. The `-min` variant
 * downloads the binary from GitHub at cold-start and extracts it to /tmp,
 * which on Vercel was racing/timing out and leaving a non-executable
 * `/tmp/chromium` that triggered EACCES on every retry.
 */

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

async function tryLaunchServerless() {
  const [{ default: puppeteerCore }, { default: chromium }, fs] = await Promise.all([
    import("puppeteer-core"),
    import("@sparticuz/chromium"),
    import("node:fs/promises"),
  ]);
  const executablePath = await chromium.executablePath();
  // Belt-and-suspenders: Vercel's file tracer occasionally drops the +x bit
  // off bundled binaries. chmod is a no-op when the bit is already set.
  await fs.chmod(executablePath, 0o755).catch(() => {});
  return puppeteerCore.launch({
    args: [...chromium.args, ...FAST_FLAGS],
    defaultViewport: (chromium as unknown as { defaultViewport?: unknown }).defaultViewport as never,
    executablePath,
    headless: true,
  });
}

async function launchBrowserOnce() {
  const isServerless =
    !!process.env.VERCEL ||
    !!process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.USE_SPARTICUZ_CHROMIUM === "1";

  if (isServerless) {
    return await tryLaunchServerless();
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

