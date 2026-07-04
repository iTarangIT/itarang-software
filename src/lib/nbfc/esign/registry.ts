/**
 * Self-describing e-sign adapter registry (E-166, Model B).
 *
 * Each provider declares its own identity + the credential fields it needs +
 * its environments. The Settings UI renders the provider picker and the
 * credential form FROM this registry, and the credentials API validates against
 * it — so adding a new provider is: (1) add a meta entry here, (2) add a case to
 * `getEsignProvider`, (3) drop in the adapter file. No other code changes.
 */
import type { EsignProvider } from "./provider";

export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
}

export interface EsignAdapterMeta {
  id: string;
  label: string; // NBFC-facing; the NBFC chose this vendor, so naming it is fine (§3.2 carve-out)
  description?: string;
  environments: ("sandbox" | "production")[];
  credentialSchema: CredentialField[];
}

/**
 * The catalogue. `digio` here means the NBFC's OWN Digio account (bring-your-own
 * keys). iTarang's shared/global Digio account is the implicit fallback used
 * when no vault row exists — it needs no entry because the NBFC configures
 * nothing for it.
 */
export const ESIGN_ADAPTERS: EsignAdapterMeta[] = [
  {
    id: "digio",
    label: "Digio (your own account)",
    description: "Use your own Digio account instead of iTarang's.",
    environments: ["sandbox", "production"],
    credentialSchema: [
      { key: "clientId", label: "Client ID", secret: false },
      { key: "clientSecret", label: "Client Secret", secret: true },
    ],
  },
  {
    id: "leegality",
    label: "Leegality",
    description: "Sign on your own Leegality workspace.",
    environments: ["sandbox", "production"],
    credentialSchema: [{ key: "authToken", label: "Auth Token (X-Auth-Token)", secret: true }],
  },
];

export function listEsignProviders(): EsignAdapterMeta[] {
  return ESIGN_ADAPTERS;
}

export function getEsignAdapterMeta(id: string): EsignAdapterMeta | null {
  return ESIGN_ADAPTERS.find((a) => a.id === id) ?? null;
}

export function isKnownEsignProvider(id: string): boolean {
  return ESIGN_ADAPTERS.some((a) => a.id === id);
}

/**
 * Lazily load the concrete adapter (mirrors getWalletFundsProvider). Static
 * import paths so the bundler can resolve them — adding a provider adds one case.
 */
export async function getEsignProvider(id: string): Promise<EsignProvider> {
  switch (id) {
    case "digio": {
      const { DigioEsignAdapter } = await import("./adapters/digio-adapter");
      return new DigioEsignAdapter();
    }
    case "leegality": {
      const { LeegalityEsignAdapter } = await import("./adapters/leegality-adapter");
      return new LeegalityEsignAdapter();
    }
    default:
      throw new Error(`BAD_REQUEST: unknown e-sign provider '${id}'`);
  }
}
