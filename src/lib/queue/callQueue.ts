import { Queue } from "bullmq";
import { connection } from "./connection";

// TODO(call-queue): dispatch path is currently unused — callQueue.add() is
// never invoked in this repo; actual call dispatch runs through
// triggerBolnaCall() directly from cron/QStash/webhook (see plan file and
// 2026-04-23 incident). If/when a caller is added, make sure
// ENABLE_CALL_WORKER=1 is also set in the target environment — otherwise
// jobs will accumulate unprocessed.

export const callQueue = new Queue("call-queue", {
  // `connection` is the non-blocking client (maxRetriesPerRequest: 2). The
  // Worker uses `blockingConnection` separately. Do not share.
  connection,

  // Sane retry defaults for any future .add(). Exponential backoff (5 s base)
  // prevents a single bad downstream (Bolna 5xx, transient network) from
  // exhausting the attempt budget instantly; 3 attempts is enough to ride
  // through routine blips without retrying indefinitely.
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  },
});
