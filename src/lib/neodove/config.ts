// NeoDove configuration (E-224).
//
// WHY THE ENDPOINT URL IS TREATED AS A SECRET. NeoDove issues no API key, no
// bearer token and no signing secret. A campaign's "Custom Integration"
// endpoint is a generated URL with an opaque token embedded in the path — so
// possession of the URL *is* write access to that campaign. It therefore:
//   * lives in an env var, never in the database (neodove_campaigns stores the
//     env var's NAME in push_endpoint_ref)
//   * is never returned to the browser, in any route, in any shape
//   * is never logged whole — see redactEndpoint()
//
// One env var per campaign, because NeoDove generates one endpoint per
// campaign. The indirection through push_endpoint_ref means adding a campaign
// is an env change plus a DB row, not a code change.

import { errorMessage } from "@/lib/api-utils";

const truthy = (v: string | undefined) =>
    v === "1" || v?.toLowerCase() === "true" || v?.toLowerCase() === "yes";

export type NeodoveConfig = {
    enabled: boolean;
    webhookSecret: string | null;
    // Dev-only escape hatch, mirroring WHATSAPP_WEBHOOK_INSECURE. Ignored in
    // production — see verifyNeodoveWebhook.
    webhookInsecure: boolean;
    // Conservative by default: NeoDove documents no rate limits at all, so the
    // safe assumption is that they exist and are low.
    pushConcurrency: number;
    pushDelayMs: number;
    requestTimeoutMs: number;
};

let cached: NeodoveConfig | null = null;

export function getNeodoveConfig(): NeodoveConfig {
    if (cached) return cached;
    cached = {
        enabled: truthy(process.env.NEODOVE_ENABLED),
        webhookSecret: process.env.NEODOVE_WEBHOOK_SECRET || null,
        webhookInsecure:
            process.env.NODE_ENV !== "production" &&
            truthy(process.env.NEODOVE_WEBHOOK_INSECURE),
        pushConcurrency: Number(process.env.NEODOVE_PUSH_CONCURRENCY ?? 5),
        pushDelayMs: Number(process.env.NEODOVE_PUSH_DELAY_MS ?? 250),
        requestTimeoutMs: Number(process.env.NEODOVE_TIMEOUT_MS ?? 15000),
    };
    return cached;
}

/** Test seam — the module-scope cache would otherwise pin the first read. */
export function resetNeodoveConfigCache(): void {
    cached = null;
}

export class NeodoveEndpointMissingError extends Error {
    constructor(ref: string) {
        super(
            `NeoDove endpoint env var "${ref}" is not set. Add it to the environment; ` +
                `it is never stored in the database because the URL is the credential.`,
        );
        this.name = "NeodoveEndpointMissingError";
    }
}

/**
 * Resolve a campaign's `push_endpoint_ref` / `update_endpoint_ref` (an env var
 * NAME) to the actual URL.
 *
 * Rejects refs that don't look like an env var name so a malicious or corrupted
 * DB row can't coerce this into reading an unrelated variable.
 */
export function resolveEndpoint(ref: string | null | undefined): string {
    if (!ref) throw new NeodoveEndpointMissingError("(none configured)");
    if (!/^[A-Z][A-Z0-9_]*$/.test(ref)) {
        throw new NeodoveEndpointMissingError(ref);
    }
    const url = process.env[ref];
    if (!url) throw new NeodoveEndpointMissingError(ref);
    return url;
}

/**
 * Does this ref resolve to a real endpoint on THIS server?
 *
 * `push_endpoint_ref IS NOT NULL` is not the same question, and the difference
 * is the whole bug this exists to close: the campaigns list used to compute
 * "wired" that way, so a campaign pointing at an env var nobody ever set looked
 * like a valid destination in the Send-to-NeoDove dropdown right up until the
 * push failed. Same function the push path calls, so the dropdown and the push
 * can no longer disagree.
 *
 * Never returns the URL — callers only ever need the boolean.
 */
export function isEndpointWired(ref: string | null | undefined): boolean {
    try {
        resolveEndpoint(ref);
        return true;
    } catch {
        return false;
    }
}

/**
 * Safe-to-log form of an endpoint URL: origin + path shape + a short digest of
 * the token. Enough to tell two campaigns apart in a log or in
 * neodove_sync_events, useless to anyone who reads it.
 */
export function redactEndpoint(url: string): string {
    try {
        const u = new URL(url);
        return `${u.origin}/…(${u.pathname.length + u.search.length} chars)`;
    } catch (err) {
        return `(unparseable endpoint: ${errorMessage(err)})`;
    }
}
