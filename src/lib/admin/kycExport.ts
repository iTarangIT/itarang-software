/**
 * B12 — bulk applicant-KYC export: one row per KYC case (a `leads` row that has
 * entered the admin verification queue), with yes/no verification flags.
 *
 * NO DOCUMENT NUMBERS. `personal_details.pan_no` / `aadhaar_no` and the raw
 * provider payloads on `kyc_verifications` are never selected here. A card is
 * "verified" when its `kyc_verifications` row succeeded or an admin accepted
 * it; the sheet carries only that Y/N. The route additionally masks the phone.
 *
 * SOURCES
 *   case            admin_verification_queue — the latest row per lead
 *                   (status pending_itarang_verification | approved | rejected
 *                   | requested_correction, submitted_at, reviewed_at)
 *   applicant       leads.owner_name / full_name, leads.phone, leads.city,
 *                   leads.kyc_status, leads.kyc_score; dealer via accounts
 *   cards           kyc_verifications (pan, aadhaar, bank, cibil) — the LATEST
 *                   row per type per lead decides the flag
 *   review          admin_kyc_reviews — latest row per lead (outcome,
 *                   rejection_reason, additional_doc_requested, reviewer)
 *                   ⚠ empty on sandbox; the final-decision audit row
 *                   (audit_logs.entity_type = 'kyc_final_decision') is the
 *                   fallback for outcome / reason / reviewer, which is how the
 *                   KYC digest reads decisions too
 *
 * FILTERS. `from`/`to` are IST days on COALESCE(reviewed_at, submitted_at);
 * `city` is a case-folded match on leads.city; `status` takes
 * either the queue vocabulary or the review screen's words (pending / verified
 * / rejected / all); `dealer_id` is accounts.id; `lead_ids` bypasses the
 * queue requirement so a hand-picked list exports even if a lead never entered
 * the queue (its case cells are then blank).
 */

import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { istRangeTz } from "@/lib/digests/window";

export interface KycExportFilters {
    /** IST days on the case date: reviewed_at, or submitted_at while unreviewed. */
    from?: string | null;
    to?: string | null;
    dealer_id?: string | null;
    /** Case-folded, trimmed equality on leads.city. */
    city?: string | null;
    status?: string | null;
    lead_ids?: string[] | null;
}

export interface KycExportRow {
    lead_id: string;
    applicant_name: string | null;
    phone: string | null;
    dealer_name: string | null;
    city: string | null;
    kyc_status: string | null;
    kyc_score: number | null;
    pan_verified: boolean;
    aadhaar_verified: boolean;
    bank_verified: boolean;
    cibil_fetched: boolean;
    outcome: string | null;
    rejection_reason: string | null;
    additional_doc_requested: string | null;
    reviewer_name: string | null;
    reviewed_at: string | null;
    submitted_at: string | null;
}

export const KYC_EXPORT_ROW_CAP = 20_000;
export const KYC_EXPORT_MAX_IDS = 2_000;

/** The review screen's filter words → queue statuses. Unknown → no filter. */
export function queueStatusesFor(status: string | null | undefined): string[] | null {
    switch ((status ?? "").trim().toLowerCase()) {
        case "pending":
            return ["pending_itarang_verification", "requested_correction"];
        case "verified":
        case "approved":
            return ["approved"];
        case "rejected":
            return ["rejected"];
        case "pending_itarang_verification":
        case "requested_correction":
            return [status!.trim().toLowerCase()];
        default:
            return null;
    }
}

function cardFlag(type: string): SQL {
    // Latest row per type per lead; success or an admin acceptance = verified.
    return sql`
        (SELECT (kv.status = 'success' OR kv.admin_action = 'accepted')
           FROM kyc_verifications kv
          WHERE kv.lead_id = l.id::text AND kv.verification_type = ${type}
          ORDER BY kv.updated_at DESC NULLS LAST, kv.created_at DESC
          LIMIT 1)`;
}

export async function fetchKycExportRows(
    f: KycExportFilters,
    limit: number = KYC_EXPORT_ROW_CAP,
): Promise<KycExportRow[]> {
    const ids = (f.lead_ids ?? []).map((s) => s.trim()).filter(Boolean).slice(0, KYC_EXPORT_MAX_IDS);
    const statuses = queueStatusesFor(f.status);

    const where: SQL[] = [sql`TRUE`];
    if (ids.length) {
        where.push(sql`l.id::text IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
    } else {
        // Without an explicit list, a row must be a real KYC case.
        where.push(sql`q.id IS NOT NULL`);
    }
    if (statuses) {
        where.push(sql`q.status IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})`);
    }
    if (f.dealer_id) where.push(sql`l.dealer_id = ${f.dealer_id}`);
    if (f.city) where.push(sql`lower(trim(l.city)) = lower(trim(${f.city}))`);
    if (f.from || f.to) {
        // The case's date: when it was reviewed, or — while still pending —
        // when it was submitted. A strict reviewed_at would make every
        // pending case vanish the moment a date is set. The review screen's
        // list filters on the same expression, so the two agree.
        where.push(istRangeTz(sql`COALESCE(q.reviewed_at, q.submitted_at)`, f.from ?? null, f.to ?? null));
    }

    const rows = await db.execute<KycExportRow>(sql`
        WITH q AS (
            SELECT DISTINCT ON (lead_id) id, lead_id, status, submitted_at, reviewed_at
              FROM admin_verification_queue
             ORDER BY lead_id, created_at DESC
        ),
        rv AS (
            SELECT DISTINCT ON (lead_id) lead_id, outcome, rejection_reason,
                   additional_doc_requested, reviewer_id, reviewed_at
              FROM admin_kyc_reviews
             ORDER BY lead_id, reviewed_at DESC NULLS LAST, created_at DESC
        ),
        fd AS (
            -- Final decision, from the append-only audit trail.
            SELECT DISTINCT ON (entity_id) entity_id AS lead_id, action,
                   changes ->> 'rejection_reason' AS rejection_reason,
                   performed_by, created_at
              FROM audit_logs
             WHERE entity_type = 'kyc_final_decision'
             ORDER BY entity_id, created_at DESC
        )
        SELECT l.id::text                                        AS lead_id,
               COALESCE(NULLIF(l.owner_name, ''), l.full_name)   AS applicant_name,
               COALESCE(NULLIF(l.phone, ''), l.mobile)           AS phone,
               a.business_entity_name                            AS dealer_name,
               l.city,
               l.kyc_status,
               l.kyc_score,
               COALESCE(${cardFlag("pan")}, false)               AS pan_verified,
               COALESCE(${cardFlag("aadhaar")}, false)           AS aadhaar_verified,
               COALESCE(${cardFlag("bank")}, false)              AS bank_verified,
               COALESCE(${cardFlag("cibil")}, false)             AS cibil_fetched,
               COALESCE(rv.outcome, fd.action, q.status)         AS outcome,
               COALESCE(rv.rejection_reason, fd.rejection_reason) AS rejection_reason,
               rv.additional_doc_requested,
               COALESCE(ru.name, fu.name)                        AS reviewer_name,
               COALESCE(rv.reviewed_at, q.reviewed_at, fd.created_at)::text AS reviewed_at,
               q.submitted_at::text                              AS submitted_at
          FROM leads l
          LEFT JOIN q ON q.lead_id = l.id::text
          LEFT JOIN rv ON rv.lead_id = l.id::text
          LEFT JOIN fd ON fd.lead_id = l.id::text
          LEFT JOIN accounts a ON a.id = l.dealer_id
          LEFT JOIN users ru ON ru.id = rv.reviewer_id
          LEFT JOIN users fu ON fu.id = fd.performed_by
         WHERE ${sql.join(where, sql` AND `)}
         ORDER BY COALESCE(q.reviewed_at, q.submitted_at) DESC NULLS LAST, l.id
         LIMIT ${limit}
    `);
    return (rows as unknown as KycExportRow[]).map((r) => ({
        ...r,
        kyc_score: r.kyc_score == null ? null : Number(r.kyc_score),
        pan_verified: !!r.pan_verified,
        aadhaar_verified: !!r.aadhaar_verified,
        bank_verified: !!r.bank_verified,
        cibil_fetched: !!r.cibil_fetched,
    }));
}
