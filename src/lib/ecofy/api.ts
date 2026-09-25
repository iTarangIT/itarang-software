// Ecofy REST API client — docs/ECOFY_INTEGRATION.md §5.
//
// Calls the same endpoints the Ecofy UI uses (docs/ecofy_openapi_v1.0.1.yaml,
// base ECOFY_API_BASE), signed instead of logged in. The call runs as the
// X-Itarang-Act-As user (default: Ecofy's ITARANG_CRM_ACTOR_EMAIL), which must
// be an ACTIVE iTarang Admin or Caller in Ecofy. Each endpoint keeps its own
// roles, gates, If-Match and Idempotency-Key rules — pass those through.
//
// Signing string: "<METHOD>\n<path and query as sent>\n<raw body or ''>", so
// the path is taken from the final URL (base path included, e.g.
// /api/v1/cases/<id>/assign) exactly as it goes on the wire.
//
// Server-only. Never import this from a client component.

import { ECOFY_OUTBOUND_ACTOR } from "./access";
import { EcofyNotConfiguredError, getEcofyConfig } from "./config";
import { ecofyApiSigningString, signEcofyPayload } from "./signature";

export type EcofyHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface EcofyApiRequest {
    method: EcofyHttpMethod;
    /** Relative to ECOFY_API_BASE, e.g. `/cases/${id}/assign`. */
    path: string;
    query?: Record<string, string | number | boolean | null | undefined>;
    body?: unknown;
    ifMatch?: string | number;
    idempotencyKey?: string;
    /** Email of an ACTIVE iTarang Admin/Caller in Ecofy. */
    actAs?: string;
    /**
     * CRM-side label only (kept in ecofy_sync_events.payload by the caller).
     * It is NOT sent to Ecofy: the X-Itarang-Actor-Name header is always the
     * fixed ECOFY_OUTBOUND_ACTOR, so Ecofy's audit never carries a person's name.
     */
    actorName?: string;
    timeoutMs?: number;
}

export interface EcofyApiError {
    code?: string;
    gate?: string;
    message?: string;
    [key: string]: unknown;
}

export interface EcofyApiResponse<T> {
    ok: boolean;
    status: number;
    /** `data` from Ecofy's `{ data }` envelope on success. */
    data: T | null;
    /** `error` from Ecofy's `{ error }` envelope on failure. */
    error: EcofyApiError | null;
    headers: Headers;
}

export async function callEcofyApi<T = unknown>(req: EcofyApiRequest): Promise<EcofyApiResponse<T>> {
    const { secret, apiBase } = getEcofyConfig();
    if (!secret) throw new EcofyNotConfiguredError("ECOFY_SYNC_SECRET");
    if (!apiBase) throw new EcofyNotConfiguredError("ECOFY_API_BASE");

    const url = new URL(`${apiBase}${req.path.startsWith("/") ? "" : "/"}${req.path}`);
    for (const [k, v] of Object.entries(req.query ?? {})) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const raw = req.body === undefined ? "" : JSON.stringify(req.body);
    const signingString = ecofyApiSigningString(req.method, `${url.pathname}${url.search}`, raw);

    const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-itarang-signature": signEcofyPayload(secret, signingString),
    };
    if (req.ifMatch !== undefined) headers["if-match"] = String(req.ifMatch);
    if (req.idempotencyKey) headers["idempotency-key"] = req.idempotencyKey;
    if (req.actAs) headers["x-itarang-act-as"] = req.actAs;
    // Fixed label on purpose — see ECOFY_OUTBOUND_ACTOR. Ecofy stores it as
    // `itarang-crm (iTarang CRM)` in audit_log.user_agent.
    headers["x-itarang-actor-name"] = ECOFY_OUTBOUND_ACTOR;

    const res = await fetch(url, {
        method: req.method,
        headers,
        body: raw || undefined,
        signal: AbortSignal.timeout(req.timeoutMs ?? 15_000),
        cache: "no-store",
    });

    const text = await res.text();
    let parsed: { data?: T; error?: EcofyApiError } | null = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = null;
    }

    return {
        ok: res.ok,
        status: res.status,
        data: res.ok ? (parsed?.data ?? null) : null,
        error: res.ok
            ? null
            : (parsed?.error ?? { message: text.slice(0, 500) || `HTTP ${res.status}` }),
        headers: res.headers,
    };
}
