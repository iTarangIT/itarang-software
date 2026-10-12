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
        FROM dealer_leads dl
        LEFT JOIN dealer_lead_commercials c
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

    // ID 169: Mark Won again after an Undo Mark Won. The undo let the form go
    // (originating_dealer_lead_id NULL) and the undo request kept its id —
    // reopen THAT form rather than starting a second one. It takes the lead's
    // GSTIN afresh (gst_number cleared; markConverted fills it) and the new
    // closer. Only an untouched form withdrawn by the undo is reopened.
    const reopened = await reopenFormWithdrawnByUndo(executor, leadId, r.closing_owner_id);
    if (reopened) {
        await executor.execute(sql`
            UPDATE dealer_leads
            SET dealer_onboarding_application_id = ${reopened},
                updated_at = NOW()
            WHERE id = ${leadId}
        `);
        return { created: false, applicationId: reopened, alreadyExisted: true };
    }

    const inserted = (await executor.execute<{ id: string }>(sql`
        INSERT INTO dealer_onboarding_applications (
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
            last_action_by, last_action_at, salesperson_user_id
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
            ${r.closing_owner_id}::uuid, NOW(),
            -- ID 66 (E-321): the rep who closed the lead is the salesperson, when
            -- they are an active ISR / ASM / Sales Head; otherwise Admin picks.
            (SELECT u.id FROM users u
              WHERE u.id::text = ${r.closing_owner_id}
                AND u.is_active
                AND LOWER(u.role) IN ('inside_sales_rep', 'asm', 'sales_head'))
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
            SELECT id FROM dealer_onboarding_applications
            WHERE originating_dealer_lead_id = ${leadId}
            LIMIT 1
        `)) as unknown as { id: string }[];
        applicationId = existing[0]?.id ?? null;

        // ID 134: an Undo Mark Won withdrew this application while it was an
        // untouched draft. Marked Won again, it is the live draft again —
        // otherwise a Won lead would sit on a withdrawn application and fall
        // straight into the drop-out review. Never reopens one the dealer
        // submitted or anything an admin withdrew for another reason. The
        // withdrawn_* columns are E-333; to_jsonb keeps a DB without it working.
        if (applicationId) {
            // ID 169: and it takes the new GSTIN — gst_number is cleared so
            // markConverted fills the lead's number. (withdrawn_* are not
            // touched here: this path must also run on a DB without E-333.)
            await executor.execute(sql`
                UPDATE dealer_onboarding_applications
                   SET onboarding_status = 'draft', gst_number = NULL, updated_at = NOW()
                 WHERE id = ${applicationId}::uuid
                   AND onboarding_status = 'withdrawn'
                   AND submitted_at IS NULL
                   AND to_jsonb(dealer_onboarding_applications) ->> 'withdrawn_reason' = 'Marked Won by mistake'
            `);
        }
    }

    if (applicationId) {
        // Back-reference so the Lead Detail can show "Onboarding initiated".
        await executor.execute(sql`
            UPDATE dealer_leads
            SET dealer_onboarding_application_id = ${applicationId},
                updated_at = NOW()
            WHERE id = ${leadId}
        `);
    }

    return { created, applicationId, alreadyExisted: !created && !!applicationId };
}

/**
 * ID 169: the form an Undo Mark Won withdrew for this lead, reopened as the
 * live draft and re-attached to the lead. Null when there is none (or E-333 is
 * not applied). The lead claim is taken back only when no other form holds it
 * (partial UNIQUE index on originating_dealer_lead_id, E-127).
 */
async function reopenFormWithdrawnByUndo(
    executor: SqlExecutor,
    leadId: string,
    closingOwnerId: string | null,
): Promise<string | null> {
    const has = (await executor.execute<{ ok: boolean }>(sql`
        SELECT to_regclass('public.lead_won_undo_requests') IS NOT NULL AS ok
    `)) as unknown as Array<{ ok: boolean }>;
    if (!has[0]?.ok) return null;
    const rows = (await executor.execute<{ id: string }>(sql`
        UPDATE dealer_onboarding_applications oa
           SET onboarding_status = 'draft',
               withdrawn_at = NULL,
               withdrawn_reason = NULL,
               gst_number = NULL,
               originating_dealer_lead_id = CASE
                   WHEN NOT EXISTS (SELECT 1 FROM dealer_onboarding_applications o
                                     WHERE o.originating_dealer_lead_id = ${leadId} AND o.id <> oa.id)
                   THEN ${leadId} ELSE oa.originating_dealer_lead_id END,
               owner_id = COALESCE(${closingOwnerId}, oa.owner_id),
               salesperson_user_id = COALESCE(
                   (SELECT u.id FROM users u
                     WHERE u.id::text = ${closingOwnerId}
                       AND u.is_active
                       AND LOWER(u.role) IN ('inside_sales_rep', 'asm', 'sales_head')),
                   oa.salesperson_user_id),
               last_action_at = NOW(),
               updated_at = NOW()
         WHERE oa.id = (
               SELECT w.id FROM dealer_onboarding_applications w
                WHERE w.onboarding_status = 'withdrawn'
                  AND w.submitted_at IS NULL
                  AND w.withdrawn_reason = 'Marked Won by mistake'
                  AND (w.originating_dealer_lead_id = ${leadId}
                       OR w.id IN (SELECT r.onboarding_application_id FROM lead_won_undo_requests r
                                    WHERE r.dealer_lead_id = ${leadId} AND r.status = 'approved'))
                ORDER BY w.updated_at DESC
                LIMIT 1)
        RETURNING oa.id::text AS id
    `)) as unknown as Array<{ id: string }>;
    return rows[0]?.id ?? null;
}
