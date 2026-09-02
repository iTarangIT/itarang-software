/**
 * The runner's pure scheduling primitives.
 *
 * Split out of runner.ts so they can be unit-tested. runner.ts imports `db`,
 * and vitest here is deliberately scoped to no-I/O tests — without this split,
 * the two pieces of logic most worth pinning (when is a collector due, and does
 * a hung collector actually get cut off) would have no coverage at all.
 *
 * Everything that touches the database — beginRun, the single-flight lock,
 * persistence — stays in runner.ts and is verified against a real Postgres
 * instead.
 */

/** Default per-collector wall-clock cap. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Due when it has never run, or when its last START is older than its interval.
 *
 * MEASURED FROM THE START, NOT THE FINISH. A collector that takes 20 seconds
 * would otherwise drift 20 seconds later every cycle, and after a few hours a
 * "every 5 minutes" collector is running at a time nobody can predict. Measuring
 * from the start keeps the cadence steady.
 */
export function isDue(
  intervalMs: number,
  lastStarted: Date | undefined | null,
  now = Date.now(),
): boolean {
  if (!lastStarted) return true;
  return now - lastStarted.getTime() >= intervalMs;
}

/**
 * Reject after `ms`, so one hung vendor call cannot stall the whole tick.
 *
 * The timer is cleared on both settle paths: a collector that resolves quickly
 * must not hold a pending timer, or a tick's worth of them keeps the event loop
 * busy long after the work is done.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
