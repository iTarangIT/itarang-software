// The CRM's side of Ecofy's REST API (docs/ECOFY_INTEGRATION.md §5, E-307).
//
// Every call is signed by callEcofyApi() and runs as Ecofy's integration user
// (ITARANG_CRM_ACTOR_EMAIL, an iTarang Admin in Ecofy). The CRM person is
// passed as X-Itarang-Actor-Name, so Ecofy's audit reads
// "itarang-crm (Priya Sharma (ASM))". Who may call what is decided BEFORE this
// module, in src/lib/ecofy/access.ts; Ecofy re-checks every gate itself.
//
// Server-only.

import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ecofyLeads } from "@/lib/db/schema";
import { errorMessage } from "@/lib/api-utils";
import { callEcofyApi, type EcofyHttpMethod } from "./api";
import type { EcofyActionInput, EcofyLeadRead, EcofyLookup } from "./actionSchemas";
import { notifyEcofySyncFailed } from "./notify";

export class EcofyCallError extends Error {
    constructor(
        message: string,
        public status: number,
        public code?: string,
        public gate?: string,
    ) {
        super(message);
        this.name = "EcofyCallError";
    }
}

interface CallOpts {
    body?: unknown;
    query?: Record<string, string | number | boolean | null | undefined>;
    ifMatch?: number;
    idempotencyKey?: string;
    actorName?: string;
    /** For the outbound ledger. */
    ecofyCaseId?: string | null;
    ecofyLeadId?: string | null;
}

function friendly(status: number, code?: string, gate?: string, message?: string): string {
    if (status === 409 && code === "VERSION_CONFLICT") return "This lead changed in Ecofy since you opened it — refresh and try again.";
    if (status === 412 || code === "PRECONDITION_FAILED") return "This lead changed in Ecofy since you opened it — refresh and try again.";
    if (status === 403) return message || "Ecofy refused this action for the integration user (it must be an ACTIVE iTarang Admin in Ecofy).";
    if (status === 404) return message || "Not found in Ecofy.";
    const base = message || `Ecofy answered ${status}`;
    return gate ? `${base} (gate: ${gate})` : base;
}

/** One Ecofy call. Throws EcofyCallError on a non-2xx; returns `data` from the envelope. */
export async function ecofyCall<T = unknown>(method: EcofyHttpMethod, path: string, opts: CallOpts = {}): Promise<T> {
    const mutating = method !== "GET";
    let res;
    try {
        res = await callEcofyApi<T>({
            method,
            path,
            query: opts.query,
            body: opts.body,
            ifMatch: opts.ifMatch,
            idempotencyKey: opts.idempotencyKey,
            actorName: opts.actorName,
        });
    } catch (err) {
        if (mutating) await logOutbound(method, path, opts, null, null, errorMessage(err));
        void notifyEcofySyncFailed({ kind: "Ecofy unreachable", detail: errorMessage(err), leadId: opts.ecofyLeadId });
        throw new EcofyCallError(`Could not reach Ecofy: ${errorMessage(err)}`, 502);
    }
    if (mutating) {
        await logOutbound(method, path, opts, res.status, res.ok ? res.data : res.error, res.ok ? null : res.error?.message ?? null);
    }
    if (res.status >= 500) {
        void notifyEcofySyncFailed({
            kind: `Ecofy API ${res.status}`,
            detail: `${method} ${path}: ${res.error?.message ?? "server error"}`,
            leadId: opts.ecofyLeadId,
        });
    }
    if (!res.ok) {
        const code = typeof res.error?.code === "string" ? res.error.code : undefined;
        const gate = typeof res.error?.gate === "string" ? res.error.gate : undefined;
        throw new EcofyCallError(friendly(res.status, code, gate, res.error?.message), res.status, code, gate);
    }
    return res.data as T;
}

/** Mutating calls land in ecofy_sync_events (direction 'outbound') for the audit trail. */
async function logOutbound(
    method: string,
    path: string,
    opts: CallOpts,
    status: number | null,
    response: unknown,
    error: string | null,
): Promise<void> {
    // event_type is varchar(60): keep ids out of it so it stays short and groupable.
    const template = path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id").replace(/\/\d+(?=\/|$)/g, "/:n");
    const eventType = `api:${method} ${template}`.slice(0, 60);
    try {
        await db.execute(sql`
            INSERT INTO ecofy_sync_events
                (direction, event_id, event_type, ecofy_case_id, ecofy_lead_id, payload, response, http_status, error)
            VALUES ('outbound', ${`crm-api-${randomUUID()}`}, ${eventType}, ${opts.ecofyCaseId ?? null},
                    ${opts.ecofyLeadId ?? null}::uuid,
                    ${JSON.stringify({ method, path, body: opts.body ?? null, actorName: opts.actorName ?? null })}::jsonb,
                    ${JSON.stringify(response ?? null)}::jsonb, ${status}, ${error})
        `);
    } catch (err) {
        console.error("[Ecofy/api] ledger write failed:", errorMessage(err));
    }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const READ_PATHS: Record<EcofyLeadRead, (caseId: string) => string> = {
    case: (c) => `/cases/${c}`,
    timeline: (c) => `/cases/${c}/timeline`,
    activities: (c) => `/cases/${c}/activities`,
    appointments: (c) => `/cases/${c}/appointments`,
    assessments: (c) => `/cases/${c}/assessments`,
    quotes: (c) => `/cases/${c}/quotes`,
    offers: (c) => `/cases/${c}/offers`,
    file: (c) => `/cases/${c}/file`,
    decisions: (c) => `/cases/${c}/financing/decisions`,
    "payment-status": (c) => `/cases/${c}/payment-status`,
    "down-payment": (c) => `/cases/${c}/down-payment`,
    installation: (c) => `/cases/${c}/installation`,
    withdrawals: (c) => `/cases/${c}/withdrawals`,
    documents: (c) => `/cases/${c}/documents`,
};

export function readLeadData(ecofyCaseId: string, what: EcofyLeadRead): Promise<unknown> {
    return ecofyCall("GET", READ_PATHS[what](ecofyCaseId));
}

const lookupCache = new Map<string, { at: number; data: unknown }>();
const LOOKUP_TTL_MS = 5 * 60 * 1000;

/** Dropdown contents (lists, EPC partners, financiers) — cached 5 minutes per process. */
export async function readLookup(what: EcofyLookup): Promise<unknown> {
    const hit = lookupCache.get(what);
    if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.data;
    const data =
        what === "epc-partners"
            ? await ecofyCall("GET", "/epc-partners", { query: { limit: 100 } })
            : what === "financiers"
              ? await ecofyCall("GET", "/financiers", { query: { limit: 100 } })
              : await ecofyCall("GET", `/lists/${what}/items`, { query: { active: true } });
    lookupCache.set(what, { at: Date.now(), data });
    return data;
}

export type EcofyQueueKind = "eligibility" | "financing" | "assets";
const QUEUE_PATHS: Record<EcofyQueueKind, string> = {
    eligibility: "/eligibility-queue",
    financing: "/financing-queue",
    assets: "/assets",
};

export function readQueue(kind: EcofyQueueKind): Promise<unknown> {
    return ecofyCall("GET", QUEUE_PATHS[kind], { query: { limit: 100 } });
}

export async function readDashboards(): Promise<{ funnel: unknown; ageing: unknown }> {
    const [funnel, ageing] = await Promise.all([
        ecofyCall("GET", "/dashboards/funnel"),
        ecofyCall("GET", "/dashboards/ageing"),
    ]);
    return { funnel, ageing };
}

export function documentDownloadUrl(documentId: string): Promise<{ url: string }> {
    return ecofyCall<{ url: string }>("GET", `/documents/${documentId}/download-url`);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface EcofyLeadRef {
    id: string;
    ecofy_case_id: string;
}

/** Runs one validated action against Ecofy. Returns Ecofy's `data`. */
export async function runEcofyAction(lead: EcofyLeadRef, input: EcofyActionInput, actorName: string): Promise<unknown> {
    const c = lead.ecofy_case_id;
    const base = { actorName, ecofyCaseId: c, ecofyLeadId: lead.id };
    switch (input.action) {
        case "log_activity":
            return ecofyCall("POST", `/cases/${c}/activities`, {
                ...base,
                body: {
                    type: input.type,
                    callOutcome: input.type === "CALL" ? input.callOutcome : undefined,
                    note: input.note || undefined,
                    nextFollowUpAt: input.nextFollowUpAt,
                },
            });
        case "book_appointment":
            return ecofyCall("POST", `/cases/${c}/appointments`, {
                ...base,
                body: {
                    meetingType: input.meetingType,
                    scheduledAt: input.scheduledAt,
                    bookingRemarks: input.bookingRemarks || undefined,
                    epcPartnerId: input.meetingType === "EPC_VISIT" ? input.epcPartnerId : undefined,
                },
            });
        case "update_appointment":
            return ecofyCall("PATCH", `/appointments/${input.appointmentId}`, {
                ...base,
                body: {
                    action: input.op,
                    scheduledAt: input.scheduledAt,
                    actualAt: input.actualAt,
                    meetingRemarks: input.meetingRemarks || undefined,
                    outcomeReason: input.outcomeReason || undefined,
                    epcFeedback: input.epcFeedback || undefined,
                },
            });
        case "advance":
            return ecofyCall("POST", `/cases/${c}/advance`, { ...base, ifMatch: input.version });
        case "save_assessment":
            return ecofyCall("POST", `/cases/${c}/assessments`, {
                ...base,
                body: {
                    method: input.method,
                    manual: {
                        batteryKwh: input.batteryKwh,
                        inverterKva: input.inverterKva,
                        solarKwp: input.solarKwp,
                        sourceNote: input.sourceNote,
                    },
                },
            });
        case "confirm_assessment":
            return ecofyCall("POST", `/assessments/${input.assessmentId}/confirm`, { ...base, ifMatch: input.version });
        case "request_eligibility":
            return ecofyCall("POST", `/cases/${c}/eligibility`, { ...base, body: { financierId: input.financierId } });
        case "quote_request":
            return ecofyCall("POST", `/cases/${c}/quote-requests`, {
                ...base,
                body: { epcPartnerId: input.epcPartnerId, channel: input.channel },
            });
        case "update_quote_request":
            return ecofyCall("PATCH", `/quote-requests/${input.quoteRequestId}`, { ...base, body: { status: input.status } });
        case "compose_offer":
            return ecofyCall("POST", `/cases/${c}/offers`, {
                ...base,
                body: { quoteId: input.quoteId },
                idempotencyKey: input.idempotencyKey,
            });
        case "send_otp":
            return ecofyCall("POST", `/offers/${input.offerId}/otp`, {
                ...base,
                ifMatch: input.version,
                idempotencyKey: input.idempotencyKey,
            });
        case "verify_otp":
            return ecofyCall("POST", `/otp/${input.challengeId}/verify`, { ...base, body: { code: input.code } });
        case "create_installation":
            return ecofyCall("POST", `/cases/${c}/installation`, {
                ...base,
                body: { epcPartnerId: input.epcPartnerId, scheduledOn: input.scheduledOn },
            });
        case "update_installation":
            return ecofyCall("PATCH", `/installations/${input.installationId}`, {
                ...base,
                body: {
                    status: input.status,
                    onDate: input.onDate,
                    note: input.note || undefined,
                    stopReason: input.status === "STOPPED" ? input.stopReason : undefined,
                    acknowledgeNoSanction: input.acknowledgeNoSanction || undefined,
                },
            });
        case "request_withdrawal":
            return ecofyCall("POST", `/cases/${c}/withdrawals`, { ...base, body: { reason: input.reason } });
        case "close":
            return ecofyCall("POST", `/cases/${c}/close`, {
                ...base,
                ifMatch: input.version,
                body: { closureReason: input.closureReason, note: input.note || undefined },
            });
        case "return":
            return ecofyCall("POST", `/cases/${c}/return`, {
                ...base,
                ifMatch: input.version,
                body: { reasonCode: input.reasonCode, note: input.note || undefined },
            });
        case "reopen":
            return ecofyCall("POST", `/cases/${c}/reopen`, { ...base, ifMatch: input.version, body: { reason: input.reason } });
        case "route_financier":
            return ecofyCall("POST", `/cases/${c}/route-financier`, {
                ...base,
                ifMatch: input.version,
                body: { financierId: input.financierId, note: input.note },
            });
        case "eligibility_decision":
            return ecofyCall("POST", `/eligibility/${input.eligibilityId}/decision`, {
                ...base,
                body: {
                    status: input.status,
                    maxEligibleInr: input.status === "ELIGIBLE" ? input.maxEligibleInr : undefined,
                    reason: input.status !== "ELIGIBLE" ? input.reason : undefined,
                },
            });
        case "financing_decision":
            return ecofyCall("POST", `/cases/${c}/financing/decisions`, {
                ...base,
                ifMatch: input.version,
                body:
                    input.status === "SANCTIONED"
                        ? {
                              status: "SANCTIONED",
                              values: {
                                  sanctionedInr: input.sanctionedInr,
                                  downPaymentInr: input.downPaymentInr,
                                  tenureMonths: input.tenureMonths,
                                  emiInr: input.emiInr,
                                  lenderFileNo: input.lenderFileNo || undefined,
                              },
                          }
                        : { status: "REJECTED", rejectionReason: input.rejectionReason },
            });
        case "down_payment":
            return ecofyCall("POST", `/cases/${c}/down-payment`, {
                ...base,
                body: { receivedOn: input.receivedOn, amountInr: input.amountInr, reference: input.reference || undefined },
            });
        case "disbursement":
            return ecofyCall("POST", `/cases/${c}/disbursement`, {
                ...base,
                ifMatch: input.version,
                body: { disbursedOn: input.disbursedOn, amountInr: input.amountInr, reference: input.reference || undefined },
            });
        case "withdrawal_confirm":
            return ecofyCall("POST", `/withdrawals/${input.withdrawalId}/confirm`, base);
        case "withdrawal_reject":
            return ecofyCall("POST", `/withdrawals/${input.withdrawalId}/reject`, { ...base, body: { reason: input.reason } });
        case "withdrawal_epc_informed":
            return ecofyCall("POST", `/withdrawals/${input.withdrawalId}/epc-informed`, base);
        case "delete_document":
            return ecofyCall("DELETE", `/documents/${input.documentId}`, { ...base, body: { reason: input.reason } });
    }
}

/** Eligibility decision straight from the queue (the case may not be a CRM lead). */
export function decideEligibility(
    eligibilityId: string,
    body: { status: string; maxEligibleInr?: number; reason?: string },
    actorName: string,
): Promise<unknown> {
    return ecofyCall("POST", `/eligibility/${eligibilityId}/decision`, { body, actorName });
}

export interface EcofyUpload {
    bytes: Buffer;
    fileName: string;
    mimeType: string;
    typeCode: string;
    recordingConsent?: boolean;
}

/**
 * Ecofy's three-step upload, done server-side so the browser never talks to
 * Ecofy: upload-url → PUT bytes to the pre-signed URL → commit with sha256.
 * `quote: true` uses the EPC-quote upload slot.
 */
export async function uploadToEcofy(
    lead: EcofyLeadRef,
    file: EcofyUpload,
    actorName: string,
    opts: { quote?: boolean } = {},
): Promise<{ id: string }> {
    const c = lead.ecofy_case_id;
    const base = { actorName, ecofyCaseId: c, ecofyLeadId: lead.id };
    const start = await ecofyCall<{ id: string; uploadUrl: string; headers?: Record<string, string> }>(
        "POST",
        `/cases/${c}/${opts.quote ? "quotes" : "documents"}/upload-url`,
        {
            ...base,
            body: { typeCode: file.typeCode, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.bytes.length },
        },
    );
    const put = await fetch(start.uploadUrl, {
        method: "PUT",
        body: new Uint8Array(file.bytes),
        headers: start.headers ?? { "Content-Type": file.mimeType },
        signal: AbortSignal.timeout(60_000),
    });
    if (!put.ok) throw new EcofyCallError(`Upload to Ecofy storage failed (${put.status})`, 502);
    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    return ecofyCall<{ id: string }>("POST", `/cases/${c}/documents`, {
        ...base,
        body: {
            documentId: start.id,
            sha256,
            ...(file.recordingConsent !== undefined ? { recordingConsent: file.recordingConsent } : {}),
        },
    });
}

export interface EcofyQuoteFields {
    assessmentId: string;
    epcPartnerId: string;
    systemDesc: string;
    batteryKwh?: number;
    inverterKva?: number;
    solarKwp?: number;
    equipmentInr: number;
    installationInr: number;
    gstInr: number;
    validUntil: string;
    notes?: string;
    provisional?: boolean;
    provisionalReason?: string;
}

/** EPC quote = PDF upload + quote record, one Idempotency-Key for the record. */
export async function uploadQuote(
    lead: EcofyLeadRef,
    pdf: EcofyUpload,
    fields: EcofyQuoteFields,
    actorName: string,
    idempotencyKey: string,
): Promise<unknown> {
    const doc = await uploadToEcofy(lead, { ...pdf, typeCode: "EPC_QUOTE" }, actorName, { quote: true });
    return ecofyCall("POST", `/cases/${lead.ecofy_case_id}/quotes`, {
        actorName,
        ecofyCaseId: lead.ecofy_case_id,
        ecofyLeadId: lead.id,
        idempotencyKey,
        body: { documentId: doc.id, ...fields },
    });
}

// ---------------------------------------------------------------------------
// Local snapshot
// ---------------------------------------------------------------------------

interface EcofyCaseView {
    version: number;
    stage: string | null;
    subStatus: string | null;
    temperature: string | null;
    closureReason: string | null;
    queueEnteredAt: string | null;
}

/**
 * Pull the case back from Ecofy after a CRM write so lists, badges and
 * notifications see the new stage at once instead of waiting for Ecofy's
 * `lead.stage_changed` push. Version-guarded like the inbound upsert, so it
 * can never roll a newer push back. Returns the previous and current stage.
 */
export async function refreshLeadFromEcofy(
    lead: EcofyLeadRef,
): Promise<{ fromStage: string | null; toStage: string | null; version: number | null }> {
    const [before] = await db
        .select({ stage: ecofyLeads.stage })
        .from(ecofyLeads)
        .where(eq(ecofyLeads.id, lead.id))
        .limit(1);
    try {
        const k = await ecofyCall<EcofyCaseView>("GET", `/cases/${lead.ecofy_case_id}`);
        await db.execute(sql`
            UPDATE ecofy_leads SET
                version = ${k.version},
                stage = ${k.stage},
                sub_status = ${k.subStatus},
                temperature = ${k.temperature ? k.temperature.toUpperCase() : null},
                closure_reason = ${k.closureReason},
                snapshot = snapshot || ${JSON.stringify({ stage: k.stage, subStatus: k.subStatus, version: k.version })}::jsonb,
                updated_at = now()
            WHERE id = ${lead.id}::uuid AND version <= ${k.version}
        `);
        return { fromStage: before?.stage ?? null, toStage: k.stage, version: k.version };
    } catch (err) {
        console.warn("[Ecofy] refresh after write failed:", errorMessage(err));
        return { fromStage: before?.stage ?? null, toStage: before?.stage ?? null, version: null };
    }
}
