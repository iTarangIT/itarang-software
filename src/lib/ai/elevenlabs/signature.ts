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

// Marker error class so the route handler can distinguish a misconfigured
// webhook (return 401 + log a warning) from a genuinely invalid signature
// (also 401, but indicates an actual attack/replay). Both look the same to
// the caller, but separating them in logs makes ops triage faster.
export class WebhookSecretMissingError extends Error {
  constructor() {
    super("ELEVENLABS_WEBHOOK_SECRET is not set");
    this.name = "WebhookSecretMissingError";
  }
}

export async function verifyWebhookEvent(
  rawBody: string,
  signatureHeader: string,
): Promise<ElevenLabsWebhookEvent> {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) {
    // Don't throw a bare Error here — it bubbles up as a 500 from the route
    // handler, which makes ElevenLabs retry forever. A typed error lets the
    // route return 401, which ElevenLabs treats as a final state.
    throw new WebhookSecretMissingError();
  }

  const event = await getClient().webhooks.constructEvent(
    rawBody,
    signatureHeader,
    secret,
  );

  return event as ElevenLabsWebhookEvent;
}
