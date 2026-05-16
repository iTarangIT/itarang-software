// Next.js instrumentation — runs once when the server boots (next dev,
// next start, or `node server.js`). This is where we kick off the
// in-process dialer-poll tick so the AI dialer recovers stuck calls
// without needing a separate worker terminal.
//
// On Vercel: serverless functions are ephemeral and this WILL run on
// cold start but won't keep ticking; Vercel cron at /api/cron/dialer-poll
// is the production heartbeat. The function below short-circuits when
// running on Vercel to avoid burning bursty function lifetime on a tick.
//
// On localhost (`npm run dev`) and PM2 / `npm run start`: the Node
// process is long-lived, so the setInterval keeps ticking for the life
// of the server.

export async function register() {
  // Only run on the Node runtime; the Edge runtime can't do setInterval
  // background work (and we hit Drizzle/postgres-js which is Node-only).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Skip on Vercel — let the cron at /api/cron/dialer-poll handle it.
  // VERCEL=1 is set in every Vercel runtime environment.
  if (process.env.VERCEL === "1") return;

  // Allow explicit opt-out (e.g. inside the BullMQ worker which already
  // owns the tick) to avoid double-polling.
  if (process.env.ENABLE_DIALER_POLL === "0") return;

  // Defer require to runtime so build-time graph analysis doesn't pull
  // server code into the wrong runtime.
  const { runDialerPollOnce } = await import(
    "@/lib/ai/pollCallStatus"
  );

  const INTERVAL_MS = 30_000;
  let inFlight = false;

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const r = await runDialerPollOnce();
      if (r.polled > 0) {
        console.log(
          `[instrumentation:dialer-poll] polled=${r.polled} finalized=${r.finalized} ` +
            `notTerminal=${r.skippedNotTerminal} errors=${r.errors}`,
        );
      }
    } catch (err) {
      console.error(
        "[instrumentation:dialer-poll] tick failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      inFlight = false;
    }
  };

  // Initial kick after a short delay so a freshly-booted server reconciles
  // any leftover 'calling' rows from a prior process.
  const kickoff = setTimeout(tick, 5_000);
  if (typeof kickoff.unref === "function") kickoff.unref();

  const interval = setInterval(tick, INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  console.log(
    "[instrumentation:dialer-poll] started (30s interval, in-process)",
  );
}
