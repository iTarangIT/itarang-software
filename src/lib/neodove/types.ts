// NeoDove integration — shared vocabulary and payload shapes (E-224).
//
// EVERYTHING NEODOVE-FACING IN THIS FILE IS PROVISIONAL until the contract is
// captured against a live account; see docs/neodove-contract.md. NeoDove
// publishes an end-user manual (docs.neodove.com) but no developer reference,
// no OpenAPI spec and no payload samples, and there is no Zapier app to
// reverse-engineer one from. The inbound shape below is a best guess built from
// the documented Workflows → Send Webhook trigger list.
//
// The guess is contained on purpose: parseInboundEvent() is the ONLY place that
// touches raw NeoDove JSON, so correcting it once the real payload is known is
// a single-function change and no caller moves.

import { z } from "zod";

// ── Outbound: what we POST to a campaign's Custom Integration endpoint ──────
//
// Documented rules: `mobile` is mandatory; `name`, `mobile` and `email` are
// RESERVED key names; every other key is stored as a custom field on the lead.
// So the CRM's own fields must be sent under non-reserved names, which is what
// the `itarang_*` prefix below is for — it also makes them obvious to an agent
// looking at the lead in NeoDove's UI.
export type NeodovePushLead = {
    mobile: string;
    name?: string;
    email?: string;
    // Custom fields — arbitrary keys, all stringified by mapper.ts because
    // NeoDove's custom-field storage is untyped.
    [customField: string]: string | undefined;
};

// ── Inbound: what NeoDove POSTs at /api/neodove/webhook ────────────────────

// Documented Workflows → Send Webhook triggers, plus the three
// Integrations → Webhook events. Both sources are normalised to this union.
export const NEODOVE_EVENT_TYPE = [
    "lead_created",
    "lead_disposed",
    "lead_deleted",
    "call_connected",
    "call_not_connected",
] as const;
export type NeodoveEventType = (typeof NEODOVE_EVENT_TYPE)[number];

// NeoDove's per-campaign disposition vocabulary is configured by the CUSTOMER
// in their UI, so it is genuinely open-ended — there is no fixed enum to
// import. It is carried as free text and mapped to our CallStatus in mapper.ts,
// where an unrecognised value is logged rather than guessed at.
export type NeodoveInboundEvent = {
    eventType: NeodoveEventType;
    // NeoDove's own identifier for this delivery. Doubles as our idempotency
    // key. When NeoDove sends nothing usable, mapper.ts synthesises a stable
    // one from (campaign, mobile, timestamp) — see synthesizeEventId.
    externalEventId: string;
    // E.164 via normalizePhone(). The fallback join key when NeoDove doesn't
    // give us a lead id.
    mobile: string | null;
    neodoveLeadId: string | null;
    // OUR id, round-tripped through NeoDove's custom fields and read back out of
    // the nested `other_properties` array. This is the most reliable join key we
    // have — it survives someone editing the phone number in NeoDove, which
    // neither `mobile` nor NeoDove's own `lead_id` does.
    itarangLeadId: string | null;
    campaignName: string | null;
    // NeoDove's campaign UUID. CONFIRMED 2026-08-03 from the sample curl on
    // their Integrations > Webhook screen: the fixed payload carries
    // `campaign_id` and NO campaign name. Everything that tried to resolve a
    // campaign by name from an inbound event was therefore unreachable.
    campaignId: string | null;
    // `call_connected` as a real boolean. The fixed webhook payload has no
    // disposition text at all — this flag plus `lead_status` (an opaque numeric
    // code) is the only outcome information it carries, so it is the sole basis
    // for a CallStatus on this path.
    callConnected: boolean | null;
    // Free-text disposition/stage exactly as NeoDove sent it. `disposition` is
    // the READABLE label (`lead_status_name`, e.g. "Open"); `dispositionCode` is
    // the opaque numeric `lead_status` (e.g. "6") kept apart from it so the code
    // can never be rendered as though it were a label.
    disposition: string | null;
    dispositionCode: string | null;
    stage: string | null;
    // NeoDove's lead tag (`lead_tag_name`), e.g. "Service Issue".
    tag: string | null;
    agentName: string | null;
    callDurationSec: number | null;
    // E-226. UNCONFIRMED: whether NeoDove's webhook carries a recording URL at
    // all depends on the account's telephony setup and on which placeholders
    // their Workflow body builder offers — check the variable picker in
    // Workflows → Send Webhook. Parsed across every plausible key so that if it
    // IS there we capture it; null costs nothing.
    recordingUrl: string | null;
    remarks: string | null;
    occurredAt: Date | null;
    name: string | null;
    email: string | null;
    city: string | null;
    // The untouched original, persisted to neodove_sync_events.request_payload.
    // This is what makes a wrong guess in parseInboundEvent recoverable: the
    // real bytes are on disk and can be re-parsed after the fact.
    raw: unknown;
};

// Deliberately permissive. A webhook that arrives in an unexpected shape must
// be STORED and flagged, never rejected at the door — with no read API, a
// refused delivery is unrecoverable. Hence: no required fields, and every
// unknown key preserved via passthrough.
export const neodoveInboundSchema = z.object({}).passthrough();

// ── Campaign + link state (mirrors the E-224 columns) ──────────────────────

/**
 * Mirror of a NeoDove campaign's own configuration (E-225).
 *
 * Everything here is DESCRIPTIVE. NeoDove exposes no campaign-creation API and
 * no read API, so these values can only be what a human copied out of their UI,
 * and writing them changes nothing on their side. They exist so a sales_head
 * can see who is working a campaign without opening NeoDove.
 *
 * `agents` is free text rather than a picked list: there is no API to fetch
 * NeoDove's users, so any dropdown would be a hand-maintained copy that goes
 * stale silently when someone joins or leaves. A stale list that looks
 * authoritative is worse than a typed name that plainly is not.
 */
export type NeodoveMirrorConfig = {
    pipeline?: string;
    managedBy?: string;
    agents?: string[];
    leadDistribution?: string;
    /** When a human last checked these against NeoDove. */
    observedAt?: string;
};

/**
 * Validation for the mirror. Shared by POST and PATCH so the two cannot drift.
 *
 * Bounded because it is free text a human types: a runaway agent list or a
 * pasted essay would land in a jsonb column nothing validates later.
 */
export const mirrorConfigSchema = z.object({
    pipeline: z.string().trim().max(120).optional(),
    managedBy: z.string().trim().max(120).optional(),
    agents: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
    leadDistribution: z.string().trim().max(60).optional(),
    observedAt: z.string().trim().max(40).optional(),
});

export const NEODOVE_CAMPAIGN_STATUS = [
    "draft",
    "pushing",
    "active",
    "paused",
    "completed",
] as const;
export type NeodoveCampaignStatus = (typeof NEODOVE_CAMPAIGN_STATUS)[number];

export const NEODOVE_PUSH_STATUS = [
    "pending",
    "pushed",
    "failed",
    "skipped_dedup",
    "skipped_excluded",
] as const;
export type NeodovePushStatus = (typeof NEODOVE_PUSH_STATUS)[number];

export type NeodovePushResult = {
    ok: boolean;
    httpStatus: number | null;
    neodoveLeadId: string | null;
    response: unknown;
    error: string | null;
};
