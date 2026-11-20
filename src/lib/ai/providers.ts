// Single source of truth for the AI dialer voice providers.
//
// Pure module (no DB / Redis imports) so client components can use it too.
// Every allow-list, type union and provider switch in the dialer derives
// from this array. Adding a provider here makes the compiler flag every
// exhaustive switch that still needs a branch (see assertNeverProvider).

export const DIALER_PROVIDERS = ["bolna", "elevenlabs", "sarvam"] as const;

export type DialerProvider = (typeof DIALER_PROVIDERS)[number];

export function isDialerProvider(value: unknown): value is DialerProvider {
  return (
    typeof value === "string" &&
    (DIALER_PROVIDERS as readonly string[]).includes(value)
  );
}

/** Narrow an untrusted value to a provider, falling back when unknown. */
export function toDialerProvider(
  value: unknown,
  fallback: DialerProvider = "bolna",
): DialerProvider {
  const v = typeof value === "string" ? value.trim().toLowerCase() : value;
  return isDialerProvider(v) ? v : fallback;
}

/** Compile-time exhaustiveness guard for provider switches. */
export function assertNeverProvider(p: never): never {
  throw new Error(`Unhandled dialer provider: ${String(p)}`);
}

export const DIALER_PROVIDER_LABEL: Record<DialerProvider, string> = {
  bolna: "Bolna",
  elevenlabs: "ElevenLabs",
  sarvam: "Sarvam",
};

/** Value written to leads.ai_owner when a provider takes a lead. */
export const DIALER_PROVIDER_AI_OWNER: Record<DialerProvider, string> = {
  bolna: "bolna_agent",
  elevenlabs: "elevenlabs_agent",
  sarvam: "sarvam_agent",
};

/** The single-call trigger route per provider (CallButton, the /leads dialer loop). */
export const DIALER_PROVIDER_CALL_ENDPOINT: Record<DialerProvider, string> = {
  bolna: "/api/bolna/call",
  elevenlabs: "/api/elevenlabs/call",
  sarvam: "/api/sarvam/call",
};
