// One entry point for "place an AI dialer call through provider X".
//
// Replaces the scattered `provider === "elevenlabs" ? triggerElevenLabsCall :
// triggerBolnaCall` tests, each of which silently dialled any third provider
// through Bolna. The switch is exhaustive: adding a provider to
// DIALER_PROVIDERS fails type-check here until it has a trigger.

import { triggerBolnaCall } from "@/lib/ai/bolna_ai/triggerCall";
import { triggerElevenLabsCall } from "@/lib/ai/elevenlabs/triggerCall";
import { triggerSarvamCall } from "@/lib/ai/sarvam/triggerCall";
import { assertNeverProvider, type DialerProvider } from "@/lib/ai/providers";

export type ProviderCallPayload = {
  leadId: string;
  phone: string;
  scheduledAt?: string;
  bypassIdempotency?: boolean;
  /** Ring this number instead of the lead's own (E-379). Bolna has no support — it dials the lead's number. */
  dialPhone?: string;
};

export type ProviderCallResult = {
  success: boolean;
  call_id?: string;
  error?: string;
  deduped?: boolean;
};

export async function triggerProviderCall(
  provider: DialerProvider,
  payload: ProviderCallPayload,
): Promise<ProviderCallResult> {
  switch (provider) {
    case "bolna": {
      // Unchanged from before the switch: Bolna was never handed dialPhone.
      const { dialPhone: _ignored, ...bolnaPayload } = payload;
      void _ignored;
      return (await triggerBolnaCall(bolnaPayload)) as ProviderCallResult;
    }
    case "elevenlabs":
      return (await triggerElevenLabsCall(payload)) as ProviderCallResult;
    case "sarvam":
      return triggerSarvamCall(payload);
    default:
      return assertNeverProvider(provider);
  }
}
