// Ecofy → CRM events — docs/ECOFY_INTEGRATION.md §3.
//
// One transaction per delivery:
//   1. claim (inbound, eventId) in ecofy_sync_events. A replay inserts nothing
//      and gets the reply stored the first time (delivery is at-least-once).
//      A concurrent duplicate blocks on the unique index until the first
//      commits, then takes the replay path.
//   2. upsert ecofy_leads by ecofy_case_id, skipping a snapshot whose version
//      is LOWER than the stored one (equal is applied: a re-push after a return
//      can arrive with the same version).
//   3. store the reply on the ledger row.
// If anything throws the whole thing rolls back, so the event is not marked
// seen and Ecofy's retry reprocesses it.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";

const nullableString = z.string().nullish();
const nullableNumber = z.number().nullish();

const customerSchema = z
    .object({
        fullName: nullableString,
        mobile: nullableString,
        altMobile: nullableString,
        email: nullableString,
        customerType: nullableString,
        businessName: nullableString,
        address: nullableString,
        city: nullableString,
        state: nullableString,
        pincode: nullableString,
        preferredLanguage: nullableString,
        propertyType: nullableString,
    })
    .passthrough();

export const ecofyLeadSchema = z
    .object({
        ecofyCaseId: z.string().min(1),
        caseNo: nullableString,
        version: z.number().int().nonnegative(),
        stage: nullableString,
        subStatus: nullableString,
        segment: nullableString,
        temperature: nullableString,
        source: nullableString,
        owner: nullableString,
        qualifiedByName: nullableString,
        queueEnteredAt: nullableString,
        productInterest: nullableString,
        avgMonthlyBillInr: nullableNumber,
        sanctionedLoadKw: nullableNumber,
        existingBackup: nullableString,
        preferredCallTime: nullableString,
        closureReason: nullableString,
        customer: customerSchema.nullish(),
        ecofyUrl: nullableString,
        crmLeadId: nullableString,
    })
    .passthrough();

export const ecofyEventSchema = z
    .object({
        eventId: z.string().min(1).max(200),
        type: z.string().min(1).max(60),
        occurredAt: nullableString,
        source: nullableString,
        tenant: nullableString,
        change: z.record(z.string(), z.unknown()).nullish(),
        lead: ecofyLeadSchema.nullish(),
    })
    .passthrough();

export type EcofyInboundEvent = z.infer<typeof ecofyEventSchema>;

export interface EcofyInboundResult {
    duplicate: boolean;
    reply: Record<string, unknown>;
}

/** ISO string or null; passed to SQL with an explicit ::timestamptz cast. */
function toTimestamp(v: string | null | undefined): string | null {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function handleEcofyEvent(
    event: EcofyInboundEvent,
    rawBody: string,
): Promise<EcofyInboundResult> {
    return db.transaction(async (tx) => {
        const claimed = await tx.execute<{ id: string }>(sql`
            INSERT INTO ecofy_sync_events (direction, event_id, event_type, ecofy_case_id, payload)
            VALUES ('inbound', ${event.eventId}, ${event.type},
                    ${event.lead?.ecofyCaseId ?? null}, ${rawBody}::jsonb)
            ON CONFLICT (direction, event_id) DO NOTHING
            RETURNING id::text AS id
        `);

        if (claimed.length === 0) {
            const prior = await tx.execute<{ response: Record<string, unknown> | null }>(sql`
                SELECT response FROM ecofy_sync_events
                WHERE direction = 'inbound' AND event_id = ${event.eventId}
            `);
            return { duplicate: true, reply: prior[0]?.response ?? { status: "duplicate" } };
        }
        const ledgerId = claimed[0].id;

        let reply: Record<string, unknown>;
        let leadId: string | null = null;

        if (event.lead) {
            leadId = await upsertLead(tx, event, event.lead);
            reply = { crmLeadId: leadId };
        } else {
            // Unknown/leadless event type: stored for inspection, acknowledged
            // so Ecofy does not retry it for six hours.
            reply = { status: "ignored" };
        }

        await tx.execute(sql`
            UPDATE ecofy_sync_events
            SET response = ${JSON.stringify(reply)}::jsonb,
                ecofy_lead_id = ${leadId}::uuid,
                http_status = 200,
                updated_at = now()
            WHERE id = ${ledgerId}::uuid
        `);

        return { duplicate: false, reply };
    });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function upsertLead(
    tx: Tx,
    event: EcofyInboundEvent,
    lead: z.infer<typeof ecofyLeadSchema>,
): Promise<string> {
    const c = lead.customer ?? {};
    const temperature = lead.temperature ? lead.temperature.toUpperCase() : null;
    const occurredAt = toTimestamp(event.occurredAt) ?? new Date().toISOString();
    const change = event.change ? JSON.stringify(event.change) : null;

    // RETURNING yields a row only when the insert or the guarded update ran;
    // a stale snapshot (lower version) falls through to the SELECT below.
    const written = await tx.execute<{ id: string }>(sql`
        INSERT INTO ecofy_leads (
            ecofy_case_id, case_no, version, stage, sub_status, segment, temperature,
            lead_source, owner, qualified_by_name, queue_entered_at, product_interest,
            avg_monthly_bill_inr, sanctioned_load_kw, existing_backup, preferred_call_time,
            closure_reason, customer_name, customer_mobile, customer_alt_mobile,
            customer_email, customer_type, business_name, address, city, state, pincode,
            preferred_language, property_type, ecofy_url, snapshot, last_change,
            last_event_id, last_event_type, last_event_at
        ) VALUES (
            ${lead.ecofyCaseId}, ${lead.caseNo ?? null}, ${lead.version}, ${lead.stage ?? null},
            ${lead.subStatus ?? null}, ${lead.segment ?? null}, ${temperature},
            ${lead.source ?? null}, ${lead.owner ?? null}, ${lead.qualifiedByName ?? null},
            ${toTimestamp(lead.queueEnteredAt)}::timestamptz, ${lead.productInterest ?? null},
            ${lead.avgMonthlyBillInr ?? null}, ${lead.sanctionedLoadKw ?? null},
            ${lead.existingBackup ?? null}, ${lead.preferredCallTime ?? null},
            ${lead.closureReason ?? null}, ${c.fullName ?? null}, ${c.mobile ?? null},
            ${c.altMobile ?? null}, ${c.email ?? null}, ${c.customerType ?? null},
            ${c.businessName ?? null}, ${c.address ?? null}, ${c.city ?? null},
            ${c.state ?? null}, ${c.pincode ?? null}, ${c.preferredLanguage ?? null},
            ${c.propertyType ?? null}, ${lead.ecofyUrl ?? null},
            ${JSON.stringify(lead)}::jsonb, ${change}::jsonb,
            ${event.eventId}, ${event.type}, ${occurredAt}::timestamptz
        )
        ON CONFLICT (ecofy_case_id) DO UPDATE SET
            case_no = EXCLUDED.case_no,
            version = EXCLUDED.version,
            stage = EXCLUDED.stage,
            sub_status = EXCLUDED.sub_status,
            segment = EXCLUDED.segment,
            temperature = EXCLUDED.temperature,
            lead_source = EXCLUDED.lead_source,
            owner = EXCLUDED.owner,
            qualified_by_name = EXCLUDED.qualified_by_name,
            queue_entered_at = EXCLUDED.queue_entered_at,
            product_interest = EXCLUDED.product_interest,
            avg_monthly_bill_inr = EXCLUDED.avg_monthly_bill_inr,
            sanctioned_load_kw = EXCLUDED.sanctioned_load_kw,
            existing_backup = EXCLUDED.existing_backup,
            preferred_call_time = EXCLUDED.preferred_call_time,
            closure_reason = EXCLUDED.closure_reason,
            customer_name = EXCLUDED.customer_name,
            customer_mobile = EXCLUDED.customer_mobile,
            customer_alt_mobile = EXCLUDED.customer_alt_mobile,
            customer_email = EXCLUDED.customer_email,
            customer_type = EXCLUDED.customer_type,
            business_name = EXCLUDED.business_name,
            address = EXCLUDED.address,
            city = EXCLUDED.city,
            state = EXCLUDED.state,
            pincode = EXCLUDED.pincode,
            preferred_language = EXCLUDED.preferred_language,
            property_type = EXCLUDED.property_type,
            ecofy_url = EXCLUDED.ecofy_url,
            snapshot = EXCLUDED.snapshot,
            last_change = COALESCE(EXCLUDED.last_change, ecofy_leads.last_change),
            last_event_id = EXCLUDED.last_event_id,
            last_event_type = EXCLUDED.last_event_type,
            last_event_at = EXCLUDED.last_event_at,
            updated_at = now()
        WHERE ecofy_leads.version <= EXCLUDED.version
        RETURNING id::text AS id
    `);
    if (written.length > 0) return written[0].id;

    const existing = await tx.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM ecofy_leads WHERE ecofy_case_id = ${lead.ecofyCaseId}
    `);
    return existing[0].id;
}
