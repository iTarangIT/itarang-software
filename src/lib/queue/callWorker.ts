import "dotenv/config";
import { Worker } from "bullmq";
import {
  blockingConnection,
  isUpstashQuotaError,
  tripQuotaCircuit,
} from "./connection";
import { triggerBolnaCall } from "@/lib/ai/bolna_ai/triggerCall";
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
