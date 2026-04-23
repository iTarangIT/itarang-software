import { Client } from "@upstash/qstash";
import { quotaCircuit } from "./connection";
import { log } from "@/lib/log";

// Lazy singleton — QStash client is only needed server-side for scheduling
// follow-up Bolna calls. Constructed on first use so we don't crash at
// import time if QSTASH_TOKEN isn't set in a given environment.
let client: Client | null = null;

function getClient(): Client {
  if (!client) {
    const token = process.env.QSTASH_TOKEN;
    if (!token) {
      throw new Error("QSTASH_TOKEN is not set");
    }
    client = new Client({
      token,
      baseUrl: process.env.QSTASH_URL,
    });
  }
  return client;
}

function buildCallbackUrl(path: string): string {
  const base =
    process.env.QSTASH_CALLBACK_BASE_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.VERCEL_URL;

  if (!base) {
    throw new Error(
      "Cannot determine callback URL. Set QSTASH_CALLBACK_BASE_URL or NEXT_PUBLIC_APP_URL.",
    );
  }

  const normalized = base.startsWith("http") ? base : `https://${base}`;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${normalized.replace(/\/$/, "")}${p}`;
}

// Throws if QStash is not properly configured. Call this at the top of any
// route that depends on QStash so we fail fast with a clear error before
// inserting DB rows that would otherwise be orphaned.
export function assertQStashConfigured(): void {
  if (!process.env.QSTASH_TOKEN) {
    throw new Error("QSTASH_TOKEN is not set");
  }
  buildCallbackUrl("/_health");
}

// Throws on failure so callers can detect and react. Wrap in try/catch if
// you want best-effort fire-and-forget semantics.
export async function publishToPath(params: {
  path: string;
  body: Record<string, unknown>;
  delaySeconds?: number;
  retries?: number;
}): Promise<string> {
  const url = buildCallbackUrl(params.path);
  const res = await getClient().publishJSON({
    url,
    body: params.body,
    delay: Math.max(0, Math.round(params.delaySeconds ?? 0)),
    retries: params.retries ?? 3,
  });
  if (!res.messageId) {
    throw new Error(`QStash publish to ${params.path} returned no messageId`);
  }
  return res.messageId;
}

export async function scheduleCall(params: {
  phone: string;
  leadId: string;
  runAt: Date;
}): Promise<string | null> {
  // Upstash quota circuit — when open, skip the publish. QStash would
  // otherwise deliver the callback to /api/bolna/dispatch-call which fails
  // at its Redis-backed webhook dedup anyway. Better to skip scheduling
  // cleanly than to fan out jobs destined to fail.
  if (quotaCircuit.tick()) {
    log.warn("[QSTASH] scheduleCall skipped: upstash quota circuit open", {
      leadId: params.leadId,
    });
    return null;
  }

  const delayMs = params.runAt.getTime() - Date.now();
  const delaySeconds = Math.max(0, Math.round(delayMs / 1000));

  try {
    const messageId = await publishToPath({
      path: "/api/bolna/dispatch-call",
      body: { phone: params.phone, leadId: params.leadId },
      delaySeconds,
    });
    log.info("[QSTASH] scheduled call", {
      leadId: params.leadId,
      delaySeconds,
      messageId,
    });
    return messageId;
  } catch (err) {
    log.error("[QSTASH] scheduleCall failed", {
      leadId: params.leadId,
      message: (err as Error).message,
    });
    return null;
  }
}
