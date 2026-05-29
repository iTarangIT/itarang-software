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

// VPS / self-hosted path: use a system-installed Chromium with puppeteer-core.
// Set PUPPETEER_EXECUTABLE_PATH to the absolute path of the chromium binary
// (e.g. /usr/bin/chromium-browser or /usr/bin/google-chrome-stable).
async function tryLaunchSystemChromium(executablePath: string) {
  const { default: puppeteerCore } = await import("puppeteer-core");
  return puppeteerCore.launch({
    executablePath,
    headless: true,
    args: FAST_FLAGS,
  });
}

async function tryLaunchLocal() {
  const { default: puppeteer } = await import("puppeteer");
  return puppeteer.launch({ headless: true, args: FAST_FLAGS });
}

// Self-healing launch order. We don't return on the first *configured* path —
// we return on the first path that actually launches. A single misconfigured
// env var or a missing binary then degrades to the next working path instead
// of hard-failing the whole PDF/agreement flow.
//
//   1. System Chrome  — PUPPETEER_EXECUTABLE_PATH (the VPS path). Skipped if the
//      env var is unset or points at a file that doesn't exist on disk.
//   2. @sparticuz     — self-contained Chromium bundled in node_modules. The
//      deploy copies node_modules/@sparticuz/chromium (incl. bin/) into the
//      standalone output, since Next.js file-tracing drops the binary dir.
//   3. Local puppeteer — dev fallback (full puppeteer, system-downloaded Chrome).
async function launchBrowserOnce() {
  const errors: string[] = [];

  const systemChromePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (systemChromePath) {
    const { existsSync } = await import("node:fs");
    if (existsSync(systemChromePath)) {
      try {
        return await tryLaunchSystemChromium(systemChromePath);
      } catch (err) {
        errors.push(`system Chrome (${systemChromePath}): ${(err as Error).message}`);
      }
    } else {
      errors.push(`system Chrome: PUPPETEER_EXECUTABLE_PATH "${systemChromePath}" does not exist`);
    }
  }

  try {
    return await tryLaunchServerless();
  } catch (err) {
    errors.push(`@sparticuz/chromium: ${(err as Error).message}`);
  }

  try {
    return await tryLaunchLocal();
  } catch (err) {
    errors.push(`local puppeteer: ${(err as Error).message}`);
  }

  throw new Error(
    `launchBrowser: every Chromium launch path failed:\n - ${errors.join("\n - ")}`,
  );
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

