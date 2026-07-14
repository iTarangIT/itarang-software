// Next.js instrumentation — runs once when the server boots (next dev,
// next start, or `node server.js`). It kicks off the in-process dialer
// tickers (poll + watchdog) so the AI dialer self-heals without needing
// a separate worker terminal. See instrumentation-node.ts for the detail.
//
// The `if (process.env.NEXT_RUNTIME === "nodejs")` wrapper is
// load-bearing — keep it a wrapping block, NEVER an early return.
// webpack replaces process.env.NEXT_RUNTIME with a string literal at
// build time, so for the Edge compilation this becomes `if (false) {…}`
// and webpack prunes the dynamic import() — plus its entire
// Drizzle/postgres-js + googleapis graph — from the edge bundle.
//
// After an early `return`, webpack does NOT prune (it only dead-code-
// eliminates statically-false `if` branches, not statements following a
// `return`). It would still compile instrumentation-node -> googleapis
// -> node:http for the Edge runtime, where Node built-ins don't exist,
// and the build fails with "Module not found: Can't resolve 'http'".
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const {
      startDialerTickers,
      startZohoSyncTicker,
      startBuybackDispatchTicker,
      startBuybackDedupTicker,
    } = await import("./instrumentation-node");
    await startDialerTickers();
    await startZohoSyncTicker();
    await startBuybackDispatchTicker();
    await startBuybackDedupTicker();
  }
}
