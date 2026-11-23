/**
 * Search ticker: the backstop for the Bright Data webhook. Starts runs whose
 * after-response start never happened, and polls running snapshots.
 */
import { queuedRunIds, refreshRun, runningRunIds, startSearchRun } from "../services/search";

export async function runSearchTick() {
  let started = 0;
  let refreshed = 0;
  for (const id of await queuedRunIds(60_000)) {
    await startSearchRun(id);
    started++;
  }
  for (const id of await runningRunIds()) {
    try {
      await refreshRun(id);
      refreshed++;
    } catch (err) {
      console.error(`[linkedin:search] refresh ${id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return { started, refreshed };
}

/** One combined tick for the in-process ticker. */
export async function runLinkedInTick(now = new Date()) {
  const { runSendTick } = await import("./sendTick");
  const { runPollTick } = await import("./pollTick");
  const search = await runSearchTick();
  const poll = await runPollTick(now);
  const send = await runSendTick(now);
  return { search, poll, send };
}
