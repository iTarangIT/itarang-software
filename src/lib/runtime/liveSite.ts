// ID 125 — "run reminder and notification jobs on production only".
//
// Sandbox and production both run NODE_ENV=production on the same box, so the
// older `NODE_ENV !== "production"` guards cannot tell them apart. This module is
// the ONE switch every scheduled job reads before an email, WhatsApp or Telegram
// message leaves the building.
//
// How it is wired: instrumentation.ts starts every ticker inside runAsJob(), and
// the sending cron routes wrap their handler the same way. AsyncLocalStorage
// carries that job name into every timer and promise the job creates, so the
// low-level senders (mailer, WhatsApp adapter, Telegram client) ask
// suppressJobSend() and drop the message when a job is sending from a site that
// is not the live one. A job's other work (status moves, lot closing, syncs)
// still runs — only the outbound message is dropped.
//
// Sends made by a person (OTP, a test send, an Assistant reply) are not inside
// a job context and are never touched.

import { AsyncLocalStorage } from "node:async_hooks";

/** pm2 app name of the live CRM (ecosystem.prod.config.js). */
const LIVE_APP_NAME = "itarang-crm-web";

type Env = Record<string, string | undefined>;

/**
 * True only on the live CRM. LIVE_SITE=1/0 decides when set (declared in
 * ecosystem.prod.config.js); otherwise the pm2 app name does. Deliberately not
 * NEXT_PUBLIC_APP_URL — Next inlines NEXT_PUBLIC_* at build time, and the build
 * runs on the CI runner, not on the box.
 */
export function isLiveSite(env: Env = process.env): boolean {
  const flag = env.LIVE_SITE?.trim().toLowerCase();
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return env.OPS_APP_NAME?.trim() === LIVE_APP_NAME;
}

/** Jobs may message real people: on the live site, or when ALLOW_JOB_SENDS=1. */
export function jobSendsAllowed(env: Env = process.env): boolean {
  return isLiveSite(env) || env.ALLOW_JOB_SENDS?.trim() === "1";
}

const jobs = new AsyncLocalStorage<string>();

/** Run `fn` (and everything it schedules) as the scheduled job `name`. */
export function runAsJob<T>(name: string, fn: () => T): T {
  return jobs.run(name, fn);
}

/** The scheduled job the current code is running under, if any. */
export function currentJob(): string | undefined {
  return jobs.getStore();
}

export type JobSendChannel = "email" | "whatsapp" | "telegram";

const reported = new Set<string>();

/**
 * Called by every low-level sender. True = drop this message: it is being sent
 * by a scheduled job on a site that is not the live one. Logs once per
 * job + channel so a 30-second ticker does not flood the log.
 */
export function suppressJobSend(channel: JobSendChannel, env: Env = process.env): boolean {
  const job = jobs.getStore();
  if (!job || jobSendsAllowed(env)) return false;
  const key = `${job}:${channel}`;
  if (!reported.has(key)) {
    reported.add(key);
    console.log(
      `[live-site] ${job}: ${channel} sends are skipped — not the live site ` +
        `(set ALLOW_JOB_SENDS=1 to send from here)`,
    );
  }
  return true;
}
