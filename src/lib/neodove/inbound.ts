// Inbound NeoDove event handling (E-224).
//
// Runs OUT of the request path (the route fast-acks 200 then calls this in
// after()), because NeoDove's retry behaviour on a slow response is
// undocumented and a timeout would produce duplicate deliveries.
//
// TWO INDEPENDENT REPLAY GUARDS, both partial unique indexes:
//   1. neodove_sync_events.external_event_id WHERE direction='inbound' — the
//      route claims this BEFORE calling us; zero rows returned = already seen.
//   2. lead_touchpoints (external_system, external_event_id) — E-113's
//      lead_touchpoints_external_uniq, written by writeTouchpoint below.
// Two guards rather than one because the first is claimed before the work and
// the second after it: a crash between them would otherwise leave an event
// marked-seen but unprocessed.

import { sql } from "drizzle-orm";
import crypto from "crypto";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { errorMessage } from "@/lib/api-utils";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { reactivateLead } from "@/lib/leads/reactivation";
import { classifyAgainstExisting, loadExistingByPhone } from "@/lib/leads/dedupe";
import { canTransition, type LeadStatus } from "@/lib/lifecycle/transitions";
import {
    callStatusFor,
    leadStatusFor,
    remarksFor,
    touchpointTypeFor,
} from "./mapper";
import type { NeodoveInboundEvent } from "./types";

export type InboundOutcome = {
    handled: boolean;
    dealerLeadId: string | null;
    action:
        | "touchpoint_written"
        | "lead_created"
        | "lead_reactivated"
        | "merge_request_raised"
        | "duplicate_skipped"
        | "delete_flagged"
        | "unresolved"
        | "error";
    note?: string;
};

/**
 * Resolve an inbound event to one of our dealer_leads.
 *
 * Three strategies, in order of reliability:
 *   1. `itarang_lead_id` — OUR id, round-tripped through NeoDove's custom
 *      fields. CONFIRMED present on live webhooks 2026-08-03. Most reliable
 *      because it survives the phone number being edited in NeoDove, which is
 *      the one thing strategies 2 and 3 cannot survive.
 *   2. neodove_lead_links.neodove_lead_id — exact, but only for leads we have
 *      previously seen an id for.
 *   3. normalised phone against dealer_leads — always available, and safe here
 *      because dealer_leads.phone is UNIQUE.
 *
 * Ordered by reliability rather than by cost: all three are single-row indexed
 * lookups, so trying the best one first is free.
 */
async function resolveInboundLead(
    event: NeodoveInboundEvent,
): Promise<string | null> {
    if (event.itarangLeadId) {
        // Verify it EXISTS rather than trusting the string. It came back from a
        // third-party system where a human can edit custom fields, so treating
        // it as a primary key unchecked would let a typo there attach a call to
        // a lead that has nothing to do with it — or to no lead at all, which
        // would fail later and more confusingly.
        const rows = await db.execute<{ id: string }>(sql`
            SELECT id FROM dealer_leads WHERE id = ${event.itarangLeadId} LIMIT 1
        `);
        if (rows[0]?.id) return rows[0].id;
        console.warn(
            "[NeoDove/inbound] itarang_lead_id not found locally, falling back:",
            event.itarangLeadId,
        );
    }

    if (event.neodoveLeadId) {
        const rows = await db.execute<{ dealer_lead_id: string }>(sql`
            SELECT dealer_lead_id FROM neodove_lead_links
            WHERE neodove_lead_id = ${event.neodoveLeadId} LIMIT 1
        `);
        if (rows[0]?.dealer_lead_id) return rows[0].dealer_lead_id;
    }

    if (event.mobile) {
        // MATCH ON THE LAST 10 DIGITS, not on the string — the same correction
        // loadExistingByPhone() already carries, for the same reason.
        //
        // event.mobile is normalised to `+91XXXXXXXXXX`, but dealer_leads.phone
        // is NOT uniformly normalised: `dealer_leads_phone_key` is unique on the
        // raw text, so `8269342343` and `+918269342343` are two different keys
        // and both get in. Measured on database-1 2026-08-04: 2396 rows stored
        // bare vs 321 stored `+91`-prefixed. An exact compare therefore missed
        // 88% of the table, and every miss became an `unresolved` sync event with
        // no touchpoint — i.e. a real call whose history never reached the CRM.
        //
        // It survived this long because strategy 1 (itarang_lead_id) covers every
        // lead WE pushed, which is all anyone tested. The phone path is the
        // fallback for leads born in NeoDove or whose custom fields were dropped,
        // and that is exactly the case it was failing.
        const last10 = event.mobile.replace(/\D/g, "").slice(-10);
        if (last10.length === 10) {
            // ORDER BY, not a bare LIMIT 1: 15 numbers currently exist under two
            // rows in different formats, so the tie must break deterministically
            // or a lead's history would scatter across both. Exact match wins
            // first; otherwise the oldest row, which is the original record — the
            // `+91` twins were created by NeoDove round-trips and carry no
            // shop_name or city.
            const rows = await db.execute<{ id: string }>(sql`
                SELECT id FROM dealer_leads
                 WHERE right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10)
                     = ${last10}
                 ORDER BY (phone = ${event.mobile}) DESC, created_at ASC NULLS LAST
                 LIMIT 1
            `);
            if (rows[0]?.id) return rows[0].id;
        }
    }

    return null;
}

export async function handleNeodoveEvent(
    event: NeodoveInboundEvent,
): Promise<InboundOutcome> {
    try {
        switch (event.eventType) {
            case "lead_created":
                return await handleLeadCreated(event);
            case "lead_deleted":
                return await handleLeadDeleted(event);
            case "lead_disposed":
            case "call_connected":
            case "call_not_connected":
                return await handleDisposition(event);
        }
    } catch (err) {
        const note = errorMessage(err);
        console.error("[NeoDove/inbound]", event.eventType, note);
        await recordError(event, note);
        return { handled: false, dealerLeadId: null, action: "error", note };
    }
}

// ── Disposition / call outcome ────────────────────────────────────────────

async function handleDisposition(
    event: NeodoveInboundEvent,
): Promise<InboundOutcome> {
    // AUTO-CREATE ON AN UNMATCHED DISPOSITION.
    //
    // This used to bail out with `unresolved` whenever the number wasn't already
    // here, on the reasoning that only LEAD_CREATE should mint a lead. That is
    // wrong for how the account is actually used: the telecallers work campaigns
    // ("Nidhi Daily Calling", "Kapil Daily Visit") whose lists were uploaded
    // straight into NeoDove and never pushed from the CRM, so no LEAD_CREATE for
    // them will EVER arrive here. Measured 2026-08-04: 16 of 16 dispositions in
    // 90 minutes matched nothing and were discarded — every one a real call with
    // an agent, a stage, a tag and a typed remark. The CRM looked broken while
    // the integration was working perfectly.
    //
    // A disposition is proof a human spoke to (or tried to reach) this number,
    // which is a better reason to hold a lead than most. So NeoDove is now a
    // first-class lead source. The cost is real and accepted: these rows arrive
    // with no city, no owner and no attribution beyond `source='neodove'` —
    // which is exactly what makes them findable if you ever want to unwind this.
    const resolved = await ensureDealerLead(event);
    if (!resolved) {
        // Only reachable with no usable mobile — nothing to match OR create on.
        const note = `No dealer_lead matched and none could be created (mobile=${event.mobile ?? "none"}, neodoveLeadId=${event.neodoveLeadId ?? "none"})`;
        await recordError(event, note);
        return { handled: false, dealerLeadId: null, action: "unresolved", note };
    }
    const dealerLeadId = resolved.id;

    // Only attempt a status change when the NeoDove stage maps to one AND the
    // transition is legal from where the lead actually is. An illegal one is
    // recorded as a plain touchpoint — the call still happened, we just don't
    // let a remote system drive our funnel into an invalid state.
    const target = leadStatusFor(event);
    let statusChange: Parameters<typeof writeTouchpoint>[0]["statusChange"];

    if (target) {
        const current = await db.execute<{
            lead_status: string | null;
            engaged: string;
        }>(sql`
            SELECT dl.lead_status,
                   (SELECT COUNT(*) FROM lead_touchpoints t
                     WHERE t.dealer_lead_id = dl.id AND t.is_engaged) ::text AS engaged
            FROM dealer_leads dl WHERE dl.id = ${dealerLeadId} LIMIT 1
        `);
        const from = (current[0]?.lead_status ?? null) as LeadStatus | null;
        if (from && from !== target) {
            const verdict = canTransition(from, target, {
                engagedTouchpointCount: Number(current[0]?.engaged ?? 0),
                actorRole: "system",
            });
            if (verdict.ok) {
                statusChange = { from, to: target, closingRole: "system" };
            } else {
                console.warn(
                    `[NeoDove/inbound] refused ${from} → ${target} for ${dealerLeadId}: ${verdict.reason}`,
                );
            }
        }
    }

    const callStatus = callStatusFor(event);

    const { touchpointId } = await writeTouchpoint({
        dealerLeadId,
        touchpointType: touchpointTypeFor(event.eventType),
        // null = system-generated. The NeoDove agent has no users row here, and
        // inventing one would pollute ownership attribution (BRD §0.3) — their
        // name goes to external_agent_name instead (E-226).
        performedBy: null,
        performedAt: event.occurredAt ?? new Date(),
        callStatus,
        callDurationSec: event.callDurationSec,
        isEngaged: callStatus === "connected",
        remarks: remarksFor(event),
        externalSystem: "neodove",
        externalEventId: event.externalEventId,
        syncMethod: "api",
        statusChange,
    });

    await attachCallEvidence(touchpointId, event);

    await db.execute(sql`
        UPDATE dealer_leads
           SET neodove_synced_at = NOW(), neodove_sync_status = 'inbound'
         WHERE id = ${dealerLeadId}
    `);

    await db.execute(sql`
        UPDATE neodove_lead_links SET last_event_at = NOW()
         WHERE dealer_lead_id = ${dealerLeadId}
    `);

    if (event.campaignName) {
        await db.execute(sql`
            UPDATE neodove_campaigns
               SET dispositions_received = dispositions_received + 1,
                   updated_at = NOW()
             WHERE neodove_campaign_name = ${event.campaignName}
        `);
    }

    return {
        handled: true,
        dealerLeadId,
        action: resolved.created ? "lead_created" : "touchpoint_written",
    };
}

/**
 * Find the dealer_lead for an inbound event, creating one if this number has
 * never been seen here.
 *
 * Goes through the SAME dedupe classifier the bulk wizard, the Import button
 * and handleLeadCreated use — a lead born on a disposition must not get weaker
 * duplicate protection than one typed in by hand. classifyAgainstExisting()
 * returning any duplicateLeadId (skip / reactivate / address_mismatch) means we
 * already hold this dealer, so we attach to that row rather than mint a rival.
 *
 * Returns null ONLY when there is no usable mobile, which is the one case where
 * neither matching nor creating is possible.
 */
async function ensureDealerLead(
    event: NeodoveInboundEvent,
): Promise<{ id: string; created: boolean } | null> {
    const existing = await resolveInboundLead(event);
    if (existing) return { id: existing, created: false };

    if (!event.mobile) return null;

    const map = await loadExistingByPhone([event.mobile]);
    const { duplicateLeadId } = classifyAgainstExisting(
        event.city ?? "",
        map.get(event.mobile),
    );
    if (duplicateLeadId) return { id: duplicateLeadId, created: false };

    const id = `DL-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    try {
        await db.insert(dealerLeads).values({
            id,
            dealer_name: event.name ?? null,
            phone: event.mobile,
            city: event.city ?? null,
            location: event.city ?? null,
            source: "neodove",
            current_status: "new",
            total_attempts: 0,
        });
    } catch (err) {
        // dealer_leads.phone is UNIQUE on the RAW text. The two lookups above
        // both match on last-10 digits, so a collision here means a row landed
        // between them and this INSERT — a concurrent delivery for the same
        // number, which is normal when an agent disposes twice in quick
        // succession. Re-resolve rather than fail: the touchpoint is the point,
        // and it belongs on whichever row won.
        console.warn(
            "[NeoDove/inbound] create raced, re-resolving:",
            errorMessage(err),
        );
        const retry = await resolveInboundLead(event);
        if (!retry) throw err;
        return { id: retry, created: false };
    }

    await markSynced(id, "inbound");
    return { id, created: true };
}

// ── Lead created in NeoDove (this is what makes the sync two-way) ─────────

async function handleLeadCreated(
    event: NeodoveInboundEvent,
): Promise<InboundOutcome> {
    if (!event.mobile) {
        const note = "lead_created carried no usable mobile — cannot dedupe or insert";
        await recordError(event, note);
        return { handled: false, dealerLeadId: null, action: "unresolved", note };
    }

    // Same classifier the bulk wizard, the /leads Import button and the
    // single-lead form use. A lead born in NeoDove gets exactly the same
    // treatment as one typed in by hand.
    const existing = await loadExistingByPhone([event.mobile]);
    const { outcome, duplicateLeadId } = classifyAgainstExisting(
        event.city ?? "",
        existing.get(event.mobile),
    );

    switch (outcome) {
        case "reactivate": {
            await reactivateLead({
                leadId: duplicateLeadId!,
                trigger: "admin",
                performedBy: null,
                notes: `Reactivated by a NeoDove lead-created event (${event.campaignName ?? "unknown campaign"})`,
            });
            await markSynced(duplicateLeadId!, "inbound");
            return {
                handled: true,
                dealerLeadId: duplicateLeadId,
                action: "lead_reactivated",
            };
        }

        case "address_mismatch": {
            await db.execute(sql`
                INSERT INTO duplicate_merge_requests
                    (request_type, source_lead_id, target_lead_id, requested_by,
                     request_notes, status)
                VALUES ('address_mismatch_upload', NULL, ${duplicateLeadId}, NULL,
                    ${`NeoDove lead-created: mobile ${event.mobile} matched an existing lead; NeoDove address "${event.city ?? "(none)"}" differs.`},
                    'pending')
            `);
            return {
                handled: true,
                dealerLeadId: duplicateLeadId,
                action: "merge_request_raised",
            };
        }

        case "duplicate_skip":
            await linkLead(duplicateLeadId!, event);
            return {
                handled: true,
                dealerLeadId: duplicateLeadId,
                action: "duplicate_skipped",
            };

        case "valid": {
            const id = `DL-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
            await db.insert(dealerLeads).values({
                id,
                dealer_name: event.name ?? null,
                phone: event.mobile,
                city: event.city ?? null,
                location: event.city ?? null,
                source: "neodove",
                current_status: "new",
                total_attempts: 0,
            });
            // The two neodove_* columns are set separately by raw SQL rather
            // than named here: they are intentionally absent from the Drizzle
            // schema object so that ~20 unrelated bare selects on dealer_leads
            // don't hard-depend on E-224 having been applied. See schema.ts.
            await markSynced(id, "inbound");
            await linkLead(id, event);
            return { handled: true, dealerLeadId: id, action: "lead_created" };
        }
    }
}

// ── Lead deleted in NeoDove ──────────────────────────────────────────────

async function handleLeadDeleted(
    event: NeodoveInboundEvent,
): Promise<InboundOutcome> {
    const dealerLeadId = await resolveInboundLead(event);
    if (!dealerLeadId) {
        return { handled: false, dealerLeadId: null, action: "unresolved" };
    }

    // Flag, never delete. A remote system's delete is not authority to destroy
    // a CRM lead that may carry touchpoints, commercials and an onboarding
    // application. A human decides.
    await writeTouchpoint({
        dealerLeadId,
        touchpointType: "status_change_note",
        performedBy: null,
        performedAt: event.occurredAt ?? new Date(),
        remarks: `[NeoDove] Lead was DELETED in NeoDove — not deleted here. Review if this lead should be closed.`,
        externalSystem: "neodove",
        externalEventId: event.externalEventId,
        syncMethod: "api",
    });

    return { handled: true, dealerLeadId, action: "delete_flagged" };
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Attach the recording URL and the NeoDove agent's name to a touchpoint (E-226).
 *
 * A SEPARATE STATEMENT, AFTER THE TRANSACTION, ON PURPOSE. `lead_touchpoints`
 * is written through Drizzle, and Drizzle names every column of the table object
 * in its INSERT — so these two columns are deliberately absent from schema.ts
 * and cannot be set by writeTouchpoint without breaking every touchpoint write
 * on a database that hasn't applied E-226 (prod, today). Running it here, after
 * the commit and inside a try/catch, means an unapplied migration costs a
 * recording URL and never the touchpoint itself. Note a failed statement aborts
 * an open transaction in Postgres — which is exactly why this is not folded into
 * writeTouchpoint's `tx`.
 *
 * No-ops when neither field is present, which is every event until NeoDove's
 * real payload is captured.
 */
export async function attachCallEvidence(
    touchpointId: string,
    event: NeodoveInboundEvent,
): Promise<void> {
    if (!event.recordingUrl && !event.agentName) return;
    try {
        await db.execute(sql`
            UPDATE lead_touchpoints
               SET recording_url = COALESCE(${event.recordingUrl}, recording_url),
                   external_agent_name = COALESCE(${event.agentName}, external_agent_name)
             WHERE touchpoint_id = ${touchpointId}::uuid
        `);
    } catch (err) {
        console.warn(
            "[NeoDove/inbound] recording/agent not stored (is E-226 applied?):",
            errorMessage(err),
        );
    }
}

async function markSynced(dealerLeadId: string, status: string): Promise<void> {
    await db.execute(sql`
        UPDATE dealer_leads
           SET neodove_synced_at = NOW(), neodove_sync_status = ${status}
         WHERE id = ${dealerLeadId}
    `);
}

// Best-effort link so a later disposition resolves by lead id rather than
// falling back to phone. Only possible when we can identify the campaign.
async function linkLead(
    dealerLeadId: string,
    event: NeodoveInboundEvent,
): Promise<void> {
    if (!event.campaignName) return;
    await db.execute(sql`
        INSERT INTO neodove_lead_links
            (dealer_lead_id, neodove_campaign_id, neodove_lead_id, push_status, last_event_at)
        SELECT ${dealerLeadId}, c.id, ${event.neodoveLeadId}, 'skipped_dedup', NOW()
          FROM neodove_campaigns c
         WHERE c.neodove_campaign_name = ${event.campaignName}
         LIMIT 1
        ON CONFLICT (dealer_lead_id, neodove_campaign_id) DO UPDATE
            SET last_event_at = NOW(),
                neodove_lead_id = COALESCE(neodove_lead_links.neodove_lead_id,
                                           EXCLUDED.neodove_lead_id)
    `);
}

// Attach a failure reason to the already-claimed sync-event row, so the raw
// payload and the reason it couldn't be processed live together.
async function recordError(
    event: NeodoveInboundEvent,
    note: string,
): Promise<void> {
    try {
        await db.execute(sql`
            UPDATE neodove_sync_events
               SET error = ${note}
             WHERE direction = 'inbound'
               AND external_event_id = ${event.externalEventId}
        `);
    } catch (err) {
        console.error("[NeoDove/inbound] failed to record error:", errorMessage(err));
    }
}
