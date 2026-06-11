// Adapter selector. The orchestrator + webhook call getAdapter() and depend only
// on the WhatsAppAdapter interface, so swapping providers is a one-line change
// here (design §0 principle 4, §10).

import { MetaWhatsAppAdapter } from "./meta";
import type { WhatsAppAdapter } from "./types";

let cached: WhatsAppAdapter | null = null;

export function getAdapter(): WhatsAppAdapter {
  if (cached) return cached;
  const provider = (process.env.WHATSAPP_PROVIDER || "meta").toLowerCase();
  switch (provider) {
    case "meta":
      cached = new MetaWhatsAppAdapter();
      break;
    // case "interakt": cached = new InteraktAdapter(); break;   // future
    // case "gupshup":  cached = new GupshupAdapter();  break;   // future
    default:
      throw new Error(`[WhatsApp] unknown WHATSAPP_PROVIDER: ${provider}`);
  }
  return cached;
}

export * from "./types";
