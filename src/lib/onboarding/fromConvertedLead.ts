// BRD §0.13 Point A — Conversion → Onboarding.
//
// When an Inside Sales rep / ASM marks a dealer lead Converted, hand the won
// deal to the onboarding team by creating a DRAFT dealer_onboarding_applications
// row pre-populated from the lead + its current commercials.
//
// Idempotent: the partial UNIQUE index on originating_dealer_lead_id (E-127) +
// ON CONFLICT DO NOTHING means a re-converted (Lost → Reactivated → Converted-
// again) lead reuses its existing application row rather than duplicating it.
//
// No-regression note: the created row has dealer_user_id = NULL and
// onboarding_status = 'draft', so it is invisible to the dealer self-service
// portal (keyed by dealer_user_id) and to the admin dealer-verification queue
// (which lists submitted/pending applications, not drafts). It simply waits
// for the onboarding team to take it forward.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

import { dealerLeads, dealerLeadCommercials, dealerOnboardingApplications } from "@/lib/db/schema";

type ConvertedLeadRow = {
    dealer_name: string | null;
    shop_name: string | null;
    phone: string | null;
    location: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    language: string | null;
    segments: unknown;
    preliminary_payment_intent: string | null;
    ai_session_id: string | null;
    final_intent_score: number | null;
    closing_owner_id: string | null;
    closing_role: string | null;
    memory: unknown;
    c_final_price: string | null;
    c_credit_terms: string | null;
    c_delivery_terms: string | null;
    c_warranty_terms: string | null;
    c_payment_method: string | null;
    c_deal_notes: string | null;
    c_notes: string | null;
    c_quote_url: string | null;
};

// dealer_leads has no structured contact email column — bulk-uploaded leads
// park it in memory.bulk_upload.email. Best-effort extraction.
function extractEmail(memory: unknown): string | null {
    if (memory && typeof memory === "object") {
        const bu = (memory as Record<string, unknown>).bulk_upload;
        if (bu && typeof bu === "object") {
            const e = (bu as Record<string, unknown>).email;
            if (typeof e === "string" && e.trim()) return e.trim();
        }
    }
    return null;
}

// `db` or a live transaction handle — both expose `.execute`. Letting the
// caller pass its transaction lets conversion + onboarding creation commit or
// roll back as one unit (BRD §0.13: never Converted without an application).
type SqlExecutor = Pick<typeof db, "execute">;

export async function createOnboardingApplicationForConvertedLead(
    leadId: string,
    executor: SqlExecutor = db,
): Promise<{ created: boolean; applicationId: string | null; alreadyExisted: boolean }> {
    const rows = (await executor.execute<ConvertedLeadRow>(sql`
        SELECT
            dl.dealer_name, dl.shop_name, dl.phone, dl.location, dl.city,
            dl.state, dl.pincode, dl.language, dl.segments,
            dl.preliminary_payment_intent, dl.ai_session_id,
            dl.final_intent_score, dl.closing_owner_id, dl.closing_role,
            dl.memory,
            c.final_price::text AS c_final_price,
            c.credit_terms      AS c_credit_terms,
            c.delivery_terms    AS c_delivery_terms,
            c.warranty_terms    AS c_warranty_terms,
            c.payment_method    AS c_payment_method,
            c.deal_notes        AS c_deal_notes,
            c.notes             AS c_notes,
            c.quote_document_url AS c_quote_url
        FROM ${dealerLeads} dl
        LEFT JOIN ${dealerLeadCommercials} c
            ON c.dealer_lead_id = dl.id AND c.is_current = true
        WHERE dl.id = ${leadId}
        LIMIT 1
    `)) as unknown as ConvertedLeadRow[];

    const r = rows[0];
    if (!r) return { created: false, applicationId: null, alreadyExisted: false };

    // company_name is NOT NULL on dealer_onboarding_applications.
    const companyName =
        r.dealer_name || r.shop_name || "(pending verification)";
    // BRD §0.13 Point A — the ASM that closed becomes the sponsoring ASM.
    const sponsoringAsmId =
        r.closing_role === "asm_visit" ? r.closing_owner_id : null;
    const segments = Array.isArray(r.segments) ? r.segments : [];
    const email = extractEmail(r.memory);
    // The Inside Sales contact may or may not be the legal owner — flag the
    // owner_* fields for the onboarding team to verify during KYC.
    const fieldVerification = JSON.stringify({
        company_name: "to_be_verified",
        owner_name: "to_be_verified",
        owner_phone: "to_be_verified",
        owner_email: "to_be_verified",
    });

    const inserted = (await executor.execute<{ id: string }>(sql`
        INSERT INTO ${dealerOnboardingApplications} (
            company_name, onboarding_status,
            originating_dealer_lead_id, sponsoring_asm_id, owner_id,
            contact_name, contact_phone, contact_email,
            owner_name, owner_phone, owner_email,
            business_address, city, state, pincode,
            business_segments, communication_language, payment_intent_note,
            source_ai_session_id, source_ai_intent_score,
            proposed_deal_value, proposed_credit_terms, proposed_delivery_terms,
            proposed_warranty_terms, proposed_terms_notes, payment_method,
            deal_notes, quote_document_url, field_verification_status,
            last_action_by, last_action_at
        ) VALUES (
            ${companyName}, 'draft',
            ${leadId}, ${sponsoringAsmId}, ${r.closing_owner_id},
            ${r.dealer_name}, ${r.phone}, ${email},
            ${r.dealer_name}, ${r.phone}, ${email},
            ${r.location}, ${r.city}, ${r.state}, ${r.pincode},
            ${JSON.stringify(segments)}::jsonb, ${r.language},
            ${r.preliminary_payment_intent},
            ${r.ai_session_id}, ${r.final_intent_score},
            ${r.c_final_price}, ${r.c_credit_terms}, ${r.c_delivery_terms},
            ${r.c_warranty_terms}, ${r.c_notes}, ${r.c_payment_method},
            ${r.c_deal_notes}, ${r.c_quote_url}, ${fieldVerification}::jsonb,
            ${r.closing_owner_id}::uuid, NOW()
        )
        ON CONFLICT (originating_dealer_lead_id)
            WHERE originating_dealer_lead_id IS NOT NULL
        DO NOTHING
        RETURNING id
    `)) as unknown as { id: string }[];

    let applicationId = inserted[0]?.id ?? null;
    const created = !!applicationId;

    // Re-conversion (Lost → reactivated → Converted again): the partial UNIQUE
    // index on originating_dealer_lead_id makes the INSERT a no-op, so RETURNING
    // is empty. Fetch the application that already exists for this lead so the
    // caller (audit log / banner / notifications) still gets a valid id.
    if (!applicationId) {
        const existing = (await executor.execute<{ id: string }>(sql`
            SELECT id FROM ${dealerOnboardingApplications}
            WHERE originating_dealer_lead_id = ${leadId}
            LIMIT 1
        `)) as unknown as { id: string }[];
        applicationId = existing[0]?.id ?? null;
    }

    if (applicationId) {
        // Back-reference so the Lead Detail can show "Onboarding initiated".
        await executor.execute(sql`
            UPDATE ${dealerLeads}
            SET dealer_onboarding_application_id = ${applicationId},
                updated_at = NOW()
            WHERE id = ${leadId}
        `);
    }

    return { created, applicationId, alreadyExisted: !created && !!applicationId };
}
