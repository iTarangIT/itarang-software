import "dotenv/config";
import { Worker } from "bullmq";
import {
  blockingConnection,
  isUpstashQuotaError,
  tripQuotaCircuit,
} from "./connection";
import { triggerBolnaCall } from "@/lib/ai/bolna_ai/triggerCall";
import { runDialerPollOnce } from "@/lib/ai/pollCallStatus";
import { log } from "@/lib/log";

/**
 * BullMQ worker for "call-queue".
 *
 * Gated behind ENABLE_CALL_WORKER because the queue is currently dead code —
 * `callQueue.add()` is never invoked anywhere in the codebase; actual call
 * dispatch runs through triggerBolnaCall() directly from cron/QStash/webhook.
 * Running an idle BullMQ worker still burns Upstash quota (continuous
 * `evalsha` polling) and on 2026-04-23 produced a 60 GB log flood when the
 * quota exhausted. Keep the worker wiring in place for future use, but do
 * not start it until someone actually enqueues jobs.
 *
 * To re-enable, set `ENABLE_CALL_WORKER=1` in the process env.
 */
if (process.env.ENABLE_CALL_WORKER === "1") {
  startWorker();
} else {
  log.info(
    "[callWorker] disabled (ENABLE_CALL_WORKER!=1); no Redis polling. Set ENABLE_CALL_WORKER=1 to start.",
  );
}

/**
 * AI dialer call-status polling tick — runs INDEPENDENT of the BullMQ
 * worker gate. In production, Vercel cron hits /api/cron/dialer-poll
 * every minute; on localhost (where Vercel cron doesn't fire) this
 * setInterval is what makes calls auto-advance without ngrok.
 *
 * Set ENABLE_DIALER_POLL=0 to opt out explicitly. Otherwise: on in dev,
 * off in production (where the cron handles it and a long-running
 * worker normally doesn't exist).
 */
const DIALER_POLL_ENABLED =
  process.env.ENABLE_DIALER_POLL === "1" ||
  (process.env.NODE_ENV !== "production" &&
    process.env.ENABLE_DIALER_POLL !== "0");

if (DIALER_POLL_ENABLED) {
  startDialerPollTick();
}

function startDialerPollTick() {
  const INTERVAL_MS = 30_000;
  let inFlight = false;

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const r = await runDialerPollOnce();
      if (r.polled > 0) {
        log.info(
          `[dialer-poll] polled=${r.polled} finalized=${r.finalized} ` +
            `notTerminal=${r.skippedNotTerminal} errors=${r.errors}`,
        );
      }
    } catch (err) {
      log.error("[dialer-poll] tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inFlight = false;
    }
  };

  // Kick once on boot so a freshly-started worker doesn't wait a full
  // interval before reconciling any leftover calling rows.
  setTimeout(tick, 5_000).unref?.();

  const interval = setInterval(tick, INTERVAL_MS);
  // unref so the timer doesn't block process exit on Ctrl+C.
  if (typeof (interval as NodeJS.Timer).unref === "function") {
    (interval as NodeJS.Timer).unref();
  }
  log.info("[dialer-poll] tick started (30s interval)");
}

function startWorker() {
  // Exponential backoff for quota-pause cycles.
  const BACKOFF_SEQUENCE_MS = [30_000, 60_000, 120_000, 300_000];
  const SUCCESSES_TO_RESET = 10;
  let backoffIdx = 0;
  let resumeTimer: NodeJS.Timeout | null = null;
  let consecutiveSuccesses = 0;

  const worker = new Worker(
    "call-queue",
    async (job) => {
      const { phone, leadId } = job.data;
      log.info("[callWorker] processing job", { jobId: job.id, leadId });
      await triggerBolnaCall({ phone, leadId });
    },
    // BullMQ requires maxRetriesPerRequest: null on Worker connections —
    // blockingConnection is the dedicated client configured that way.
    { connection: blockingConnection },
  );

  function scheduleResume() {
    if (resumeTimer) return; // already scheduled
    const delay = BACKOFF_SEQUENCE_MS[
      Math.min(backoffIdx, BACKOFF_SEQUENCE_MS.length - 1)
    ];
    backoffIdx = Math.min(backoffIdx + 1, BACKOFF_SEQUENCE_MS.length - 1);
    log.warn(`[callWorker] paused: upstash quota — resuming in ${delay / 1000}s`);
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      Promise.resolve(worker.resume()).catch((err: unknown) => {
        log.error("[callWorker] resume failed", {
          message: (err as Error).message,
        });
      });
      log.info("[callWorker] resumed after quota cooldown");
    }, delay);
    if (typeof resumeTimer.unref === "function") resumeTimer.unref();
  }

  async function handleError(err: Error) {
    if (isUpstashQuotaError(err)) {
      // Trip the shared circuit so safeRedis/scheduler callers short-circuit
      // too — don't wait for the ioredis error listener to independently
      // notice.
      tripQuotaCircuit();
      // pause() without args → drain active jobs before pausing polling.
      // Wrap in Promise.resolve because BullMQ v5 types `pause()` as void
      // in some builds even though it is awaitable.
      try {
        await Promise.resolve(worker.pause());
      } catch {
        /* pause is best-effort */
      }
      scheduleResume();
      return;
    }
    log.error("[callWorker] error", { message: err.message });
  }

  // BullMQ surfaces connection/command errors on 'error' and per-job
  // failures on 'failed'. Upstash quota errors come through the polling
  // loop and land on 'error', but we wire both defensively so the same
  // pause/resume logic runs regardless of which event actually fires.
  worker.on("error", (err) => {
    void handleError(err);
  });
  worker.on("failed", (_job, err) => {
    void handleError(err as Error);
  });

  worker.on("completed", () => {
    consecutiveSuccesses += 1;
    if (consecutiveSuccesses >= SUCCESSES_TO_RESET && backoffIdx !== 0) {
      log.info("[callWorker] backoff reset after sustained success");
      backoffIdx = 0;
      consecutiveSuccesses = 0;
    }
  });

  log.info("[callWorker] started, listening for call-queue jobs");
}
