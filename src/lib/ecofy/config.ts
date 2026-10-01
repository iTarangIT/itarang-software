// Ecofy integration env — docs/ECOFY_INTEGRATION.md §1.
//
//   ECOFY_SYNC_SECRET  shared HMAC secret (≥ 32 chars, one per environment);
//                      same value as ITARANG_CRM_SECRET on the Ecofy side
//   ECOFY_EVENTS_URL   Ecofy's inbound events endpoint (§4), e.g.
//                      https://sandbox-ecofy.itarang.com/api/v1/integrations/itarang/events
//   ECOFY_API_BASE     Ecofy REST base (§5), e.g. https://sandbox-ecofy.itarang.com/api/v1
//
// Server-only. The secret must never reach a browser.

export interface EcofyConfig {
    secret: string | null;
    eventsUrl: string | null;
    apiBase: string | null;
}

const MIN_SECRET_LENGTH = 32;

export function getEcofyConfig(): EcofyConfig {
    const secret = process.env.ECOFY_SYNC_SECRET?.trim() || null;
    if (secret && secret.length < MIN_SECRET_LENGTH) {
        // A short secret is a misconfiguration, not a weaker mode: treat it as
        // unset so nothing is accepted or sent with it.
        console.error(`[Ecofy] ECOFY_SYNC_SECRET is shorter than ${MIN_SECRET_LENGTH} chars — ignored`);
    }
    return {
        secret: secret && secret.length >= MIN_SECRET_LENGTH ? secret : null,
        eventsUrl: process.env.ECOFY_EVENTS_URL?.trim() || null,
        apiBase: process.env.ECOFY_API_BASE?.trim().replace(/\/+$/, "") || null,
    };
}

export class EcofyNotConfiguredError extends Error {
    constructor(missing: string) {
        super(`Ecofy integration not configured: ${missing} is not set`);
        this.name = "EcofyNotConfiguredError";
    }
}
