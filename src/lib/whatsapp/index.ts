// Adapter selector. The orchestrator + webhook call getAdapter() and depend only
// on the WhatsAppAdapter interface, so swapping providers is a one-line change
// here (design §0 principle 4, §10).

import { DryRunWhatsAppAdapter } from "./dry-run";
import { MetaWhatsAppAdapter } from "./meta";
import { getWhatsAppLanguage } from "./language-settings";
import { translateBatch } from "./translate";
import { TranslatingWhatsAppAdapter } from "./translating-adapter";
import type { WhatsAppAdapter } from "./types";

let cached: WhatsAppAdapter | null = null;

export function getAdapter(): WhatsAppAdapter {
  if (cached) return cached;
  // WA_DRY_RUN outranks the provider setting on purpose: a verification script
  // sets it without touching WHATSAPP_PROVIDER, and forgetting to unset the
  // provider would then message real customers from a test run.
  if (process.env.WA_DRY_RUN === "1") {
    cached = new DryRunWhatsAppAdapter();
    return cached;
  }
  const provider = (process.env.WHATSAPP_PROVIDER || "meta").toLowerCase();
  switch (provider) {
    case "meta":
      // Wrapped so every free-form send is localised to the language chosen
      // at /admin/settings/whatsapp/language. English = pure pass-through.
      // The dry-run adapter is deliberately NOT wrapped: verification scripts
      // and tests assert on the English copy the flows produce.
      cached = new TranslatingWhatsAppAdapter(
        new MetaWhatsAppAdapter(),
        getWhatsAppLanguage,
        translateBatch,
      );
      break;
    case "dry-run":
      cached = new DryRunWhatsAppAdapter();
      break;
    // case "interakt": cached = new InteraktAdapter(); break;   // future
    // case "gupshup":  cached = new GupshupAdapter();  break;   // future
    default:
      throw new Error(`[WhatsApp] unknown WHATSAPP_PROVIDER: ${provider}`);
  }
  return cached;
}

export * from "./types";
