import { Client } from "@upstash/qstash";

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

export async function publishToPath(params: {
  path: string;
  body: Record<string, unknown>;
  delaySeconds?: number;
  retries?: number;
}): Promise<string | null> {
  try {
    const res = await getClient().publishJSON({
      url: buildCallbackUrl(params.path),
      body: params.body,
      delay: Math.max(0, Math.round(params.delaySeconds ?? 0)),
      retries: params.retries ?? 3,
    });
    return res.messageId;
  } catch (err) {
    console.error("[QSTASH] publish failed", { path: params.path, err });
    return null;
  }
}

export async function scheduleCall(params: {
  phone: string;
  leadId: string;
  runAt: Date;
}): Promise<string | null> {
  const delayMs = params.runAt.getTime() - Date.now();
  const delaySeconds = Math.max(0, Math.round(delayMs / 1000));

  const messageId = await publishToPath({
    path: "/api/bolna/dispatch-call",
    body: { phone: params.phone, leadId: params.leadId },
    delaySeconds,
  });

  console.log("[QSTASH] scheduled call", {
    leadId: params.leadId,
    delaySeconds,
    messageId,
  });

  return messageId;
}
