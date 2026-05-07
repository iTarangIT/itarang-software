import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { ElevenLabsWebhookEvent } from "./types";

let client: ElevenLabsClient | null = null;

function getClient(): ElevenLabsClient {
  if (!client) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error("ELEVENLABS_API_KEY is not set");
    }
    client = new ElevenLabsClient({ apiKey });
  }
  return client;
}

export async function verifyWebhookEvent(
  rawBody: string,
  signatureHeader: string,
): Promise<ElevenLabsWebhookEvent> {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("ELEVENLABS_WEBHOOK_SECRET is not set");
  }

  const event = await getClient().webhooks.constructEvent(
    rawBody,
    signatureHeader,
    secret,
  );

  return event as ElevenLabsWebhookEvent;
}
