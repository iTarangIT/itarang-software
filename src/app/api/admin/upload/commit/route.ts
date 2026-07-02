// POST /api/admin/upload/commit — BRD §0.4 Step 3/4. Re-validates the CSV
// server-side (never trusts client classification), creates the upload_batches
// row, inserts the new leads, reactivates Lost matches, skips exact duplicates,
// and files address-mismatch merge requests. Sets the 24h rollback window.
//
// The BRD specs this as a background job; for V1 (≤5000 rows) it runs inline
// — no BullMQ worker dependency, and the admin sees the result immediately.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    generateId,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import {
    MAX_UPLOAD_ROWS,
    parseCsv,
    parseHeaders,
    validateUpload,
} from "@/lib/admin/csvUpload";
import { reactivateLead } from "@/lib/leads/reactivation";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import type { UploadBatchSummary } from "@/lib/admin/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BodySchema = z.object({
    file_name: z.string().trim().min(1).max(255),
    csv_text: z.string().min(1).max(6_000_000),
    routing_to_ai: z.boolean().default(false),
    source_label: z.string().trim().max(120).optional().nullable(),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(["admin", "sales_head", "sales_insight", "inside_sales_rep"]);
    const b = BodySchema.parse(await req.json());

    const parsed = parseCsv(b.csv_text);
    if (parsed.length === 0) {
        return errorResponse("CSV has no data rows.", 400);
    }
    if (parsed.length > MAX_UPLOAD_ROWS) {
        return errorResponse(
            `CSV has ${parsed.length} rows — the limit is ${MAX_UPLOAD_ROWS}.`,
            400,
        );
    }

    const result = await validateUpload(parsed, parseHeaders(b.csv_text));

    // Create the batch row.
    const batchRows = await db.execute<{ batch_id: string }>(sql`
        INSERT INTO upload_batches
            (uploaded_by, file_name, total_rows, valid_rows, errored_rows,
             duplicate_rows, routing_to_ai, source_label, status)
        VALUES (${user.id}, ${b.file_name}, ${result.total_rows},
            ${result.valid_rows + result.reactivate_rows},
            ${result.errored_rows},
            ${result.duplicate_rows + result.address_mismatch_rows},
            ${b.routing_to_ai}, ${b.source_label ?? null}, 'processing')
        RETURNING batch_id
    `);
    const batchId = batchRows[0]!.batch_id;

    // BRD §0.4 Step 2 — AI-routing toggle decides the initial states.
    const leadStatus = b.routing_to_ai ? null : "New_Unassigned";
    const aiRecall = b.routing_to_ai ? "awaiting_re_dial" : "qualified";
    const interest = b.routing_to_ai ? null : "warm";

    for (const row of result.rows) {
        if (row.status === "error" || !row.payload) continue;
        const p = row.payload;

        if (row.status === "valid") {
            const id = await generateId("DL");
            // dealer_leads has no contact_person / email / capacity / supplier
            // columns — park those CSV extras in memory JSONB.
            const memory = JSON.stringify({
                bulk_upload: {
                    contact_person: p.contact_person,
                    email: p.email,
                    monthly_capacity: p.monthly_capacity,
                    current_supplier: p.current_supplier,
                },
            });

            // A resolved assignee sends the lead straight into that person's
            // queue and overrides the AI-routing toggle (assignment wins). We
            // land it at Assigned_Not_Contacted for both reps and ASMs — the
            // same status the ASM self-assign create flow uses so it appears in
            // their active list; ASM targets also get asm_id set.
            const owner = p.assigned_owner_id;
            const isAsm = p.assigned_owner_role === "asm";
            const rowLeadStatus = owner ? "Assigned_Not_Contacted" : leadStatus;
            const rowAiRecall = owner ? "qualified" : aiRecall;
            const rowInterest = owner ? "warm" : interest;

            await db.execute(sql`
                INSERT INTO dealer_leads
                    (id, phone, dealer_name, city, state, language, segments,
                     preliminary_payment_intent, source, upload_batch_id,
                     lead_status, ai_recall_status, interest_level,
                     final_intent_score, is_active, memory,
                     current_owner_id, originator_id, asm_id, assigned_at,
                     created_at, updated_at)
                VALUES (${id}, ${p.phone}, ${p.dealer_name}, ${p.city}, ${p.state},
                    ${p.language}, ${JSON.stringify(p.segments)}::jsonb,
                    ${p.preliminary_payment_intent}, 'manual_upload_lead',
                    ${batchId}, ${rowLeadStatus}, ${rowAiRecall}, ${rowInterest},
                    NULL, TRUE, ${memory}::jsonb,
                    ${owner}, ${owner ? user.id : null},
                    ${isAsm ? owner : null}, ${owner ? sql`NOW()` : null},
                    NOW(), NOW())
                ON CONFLICT (phone) DO NOTHING
            `);
            if (owner) {
                await writeTouchpoint({
                    dealerLeadId: id,
                    touchpointType: "ownership_transfer",
                    performedBy: user.id,
                    remarks: `Assigned via bulk upload (batch ${batchId}).`,
                });
            }
            if (p.prior_call_notes) {
                await db.execute(sql`
                    INSERT INTO lead_touchpoints
                        (dealer_lead_id, touchpoint_type, performed_by,
                         performed_at, remarks, sync_method)
                    VALUES (${id}, 'status_change_note', ${user.id}, NOW(),
                        ${`Prior call notes (bulk upload): ${p.prior_call_notes}`},
                        'manual')
                `);
            }
        } else if (row.status === "reactivate" && row.duplicate_lead_id) {
            await reactivateLead({
                leadId: row.duplicate_lead_id,
                trigger: "upload",
                performedBy: user.id,
                notes: `Reactivated via bulk upload (batch ${batchId})`,
            });
            if (p.prior_call_notes) {
                await db.execute(sql`
                    INSERT INTO lead_touchpoints
                        (dealer_lead_id, touchpoint_type, performed_by,
                         performed_at, remarks, sync_method)
                    VALUES (${row.duplicate_lead_id}, 'status_change_note',
                        ${user.id}, NOW(),
                        ${`Prior call notes (bulk upload): ${p.prior_call_notes}`},
                        'manual')
                `);
            }
        } else if (row.status === "duplicate_skip" && row.duplicate_lead_id) {
            if (p.prior_call_notes) {
                await db.execute(sql`
                    INSERT INTO lead_touchpoints
                        (dealer_lead_id, touchpoint_type, performed_by,
                         performed_at, remarks, sync_method)
                    VALUES (${row.duplicate_lead_id}, 'status_change_note',
                        ${user.id}, NOW(),
                        ${`Duplicate skipped on bulk upload — prior call notes: ${p.prior_call_notes}`},
                        'manual')
                `);
            }
        } else if (row.status === "address_mismatch" && row.duplicate_lead_id) {
            await db.execute(sql`
                INSERT INTO duplicate_merge_requests
                    (request_type, source_lead_id, target_lead_id, requested_by,
                     request_notes, status)
                VALUES ('address_mismatch_upload', NULL, ${row.duplicate_lead_id},
                    ${user.id},
                    ${`Bulk upload row ${row.row_number}: phone ${p.phone} matched an existing lead; uploaded address "${p.city}, ${p.state}" differs.`},
                    'pending')
            `);
        }
    }

    await db.execute(sql`
        UPDATE upload_batches SET
            status = 'processed',
            rollback_window_until = NOW() + INTERVAL '24 hours',
            updated_at = NOW()
        WHERE batch_id = ${batchId}
    `);

    const summaryRows = await db.execute<UploadBatchSummary>(sql`
        SELECT batch_id, file_name, uploaded_by, NULL AS uploaded_by_name,
               total_rows, valid_rows, errored_rows, duplicate_rows,
               routing_to_ai, source_label, status, rollback_window_until,
               rolled_back_at, created_at
        FROM upload_batches WHERE batch_id = ${batchId}
    `);

    return successResponse(summaryRows[0]);
});
