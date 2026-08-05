// HTTP client for NeoDove's Custom Integration endpoints (E-224).
//
// Every attempt — success or failure — is written to neodove_sync_events.
// That is not diagnostics: NeoDove cannot be queried, so this ledger is the
// only record that a push happened at all, and the only thing a CSV
// reconciliation run has to diff against.
//
// RETRY POLICY. 5xx and network errors are retried with backoff; 4xx are not,
// because a 4xx from an endpoint whose contract we don't fully know means we
// sent something wrong and retrying sends the same wrong thing again. Rate
// limits are undocumented, so 429 IS retried, with a longer wait.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { errorMessage } from "@/lib/api-utils";
import { getNeodoveConfig, redactEndpoint, resolveEndpoint } from "./config";
import type { NeodovePushLead, NeodovePushResult } from "./types";

const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST one lead to a campaign endpoint.
 *
 * `endpointRef` is the env var NAME (neodove_campaigns.push_endpoint_ref), not
 * a URL — see config.ts for why the URL never leaves the environment.
 */
export async function pushLead(opts: {
    endpointRef: string | null;
    payload: NeodovePushLead;
    campaignId: string | null;
    dealerLeadId: string | null;
}): Promise<NeodovePushResult> {
    const { requestTimeoutMs } = getNeodoveConfig();

    let url: string;
    try {
        url = resolveEndpoint(opts.endpointRef);
    } catch (err) {
        const result: NeodovePushResult = {
            ok: false,
            httpStatus: null,
            neodoveLeadId: null,
            response: null,
            error: errorMessage(err),
        };
        await logSyncEvent({ ...opts, result, attempts: 0, endpointLabel: null });
        return result;
    }

    const endpointLabel = redactEndpoint(url);
    let last: NeodovePushResult = {
        ok: false,
        httpStatus: null,
        neodoveLeadId: null,
        response: null,
        error: "not attempted",
    };
    let attempts = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        attempts = attempt;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(opts.payload),
                signal: controller.signal,
            });

            const text = await res.text();
            let parsed: unknown = text;
            try {
                parsed = text ? JSON.parse(text) : null;
            } catch {
                // NeoDove's success response shape is undocumented; a non-JSON
                // body is not an error on its own.
            }

            last = {
                // `ok` MEANS "ACCEPTED", NOT "CREATED". Verified 2026-08-01: a
                // POST whose `mobile` was the literal placeholder string
                // "<YOUR-10-DIGIT-MOBILE>" still returned 200 OK with the body
                // `OK` — and mobile is NeoDove's ONLY mandatory field. This
                // endpoint does no validation at the HTTP layer, so a 2xx says
                // nothing about whether a lead exists on their side. Callers
                // must not report a push as confirmed on the strength of this
                // flag; only a CSV reconciliation run can do that.
                ok: res.ok,
                httpStatus: res.status,
                neodoveLeadId: extractLeadId(parsed),
                response: parsed,
                error: res.ok ? null : `HTTP ${res.status}`,
            };

            if (res.ok) break;
            // 4xx (other than 429) means our payload is wrong — resending it
            // unchanged cannot help.
            if (res.status !== 429 && res.status < 500) break;
        } catch (err) {
            last = {
                ok: false,
                httpStatus: null,
                neodoveLeadId: null,
                response: null,
                error: errorMessage(err),
            };
        } finally {
            clearTimeout(timer);
        }

        if (attempt < MAX_ATTEMPTS) {
            // Longer pause on a rate-limit than on a server error, since the
            // ceiling is unknown and we'd rather under-drive it.
            const base = last.httpStatus === 429 ? 3000 : 800;
            await sleep(base * attempt);
        }
    }

    await logSyncEvent({ ...opts, result: last, attempts, endpointLabel });
    return last;
}

/**
 * PUT/POST to a campaign's "Endpoint(Update only)" URL.
 *
 * NeoDove's matching semantics for this endpoint are UNDOCUMENTED — we do not
 * know whether it matches on mobile, on a lead id, or on something else, nor
 * what it does when no match exists. Until that is probed against a real
 * account (docs/neodove-contract.md), callers should treat a success here as
 * "probably updated" and not as a guarantee.
 */
export async function updateLead(opts: {
    endpointRef: string | null;
    payload: NeodovePushLead;
    campaignId: string | null;
    dealerLeadId: string | null;
}): Promise<NeodovePushResult> {
    return pushLead(opts);
}

// NeoDove may or may not return its lead id on create. Probe the handful of
// plausible keys; null is a fine answer — the inbound handler falls back to
// matching on normalised phone.
function extractLeadId(response: unknown): string | null {
    if (!response || typeof response !== "object") return null;
    const o = response as Record<string, unknown>;
    const nested = o.data && typeof o.data === "object" ? (o.data as Record<string, unknown>) : {};
    for (const key of ["lead_id", "leadId", "id", "uuid", "unique_id"]) {
        const v = o[key] ?? nested[key];
        if (v !== undefined && v !== null && v !== "") return String(v);
    }
    return null;
}

async function logSyncEvent(opts: {
    campaignId: string | null;
    dealerLeadId: string | null;
    payload: NeodovePushLead;
    result: NeodovePushResult;
    attempts: number;
    endpointLabel: string | null;
}): Promise<void> {
    try {
        await db.execute(sql`
            INSERT INTO neodove_sync_events
                (direction, event_type, neodove_campaign_id, dealer_lead_id,
                 http_status, request_payload, response_payload, error, attempts)
            VALUES ('outbound', 'push_lead', ${opts.campaignId}, ${opts.dealerLeadId},
                ${opts.result.httpStatus},
                ${JSON.stringify({ endpoint: opts.endpointLabel, body: opts.payload })}::jsonb,
                ${opts.result.response === null ? null : JSON.stringify(opts.result.response)}::jsonb,
                ${opts.result.error}, ${opts.attempts})
        `);
    } catch (err) {
        // Never let ledger-writing failure mask the push result itself — the
        // caller still needs to know whether the lead reached NeoDove.
        console.error("[NeoDove/client] failed to write sync event:", errorMessage(err));
    }
}
