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
import { markSalesReady } from "@/lib/leads/salesReady";
import type { UploadBatchSummary } from "@/lib/admin/types";
import { LEAD_ORIGINS } from "@/lib/leads/leadSourceVocab";
import { recordLeadsCreatedBulk, recordReinquiries, stampLeadSourceBulk } from "@/lib/leads/leadSource";
import { campaignForUploadBatch, resolveLeadCampaign } from "@/lib/leads/acquisitionCampaigns";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BodySchema = z.object({
    file_name: z.string().trim().min(1).max(255),
    csv_text: z.string().min(1).max(6_000_000),
    routing_to_ai: z.boolean().default(false),
    source_label: z.string().trim().max(120).optional().nullable(),
    // ID 81 — Found via, for every lead in the file. Required: source can only
    // be captured at creation. Entered via (bulk_upload) comes from the batch id.
    origin: z.enum(LEAD_ORIGINS, { message: "Pick how these dealers were found (Found via)." }),
    // ID 81 — the acquisition campaign for the file. Required for Trade event /
    // Digital ad; left out otherwise, the batch gets a campaign of its own.
    campaign_id: z.string().uuid().optional().nullable(),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(["admin", "sales_head", "sales_insight", "inside_sales_rep", "partner"]);
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

    // ID 81: refused before anything is written — a Trade event / Digital ad
    // file with no campaign, or a campaign that is closed or not there.
    const pickedCampaignId = await resolveLeadCampaign(db, { origin: b.origin, campaignId: b.campaign_id });

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

    // ID 81: the leads this batch created, and the dealers it found again.
    const insertedIds: string[] = [];
    const known: { id: string; note: string }[] = [];

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

            const inserted = await db.execute<{ id: string }>(sql`
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
                RETURNING id
            `);
            // The phone landed between validation and this insert — nothing
            // was created, so there is nothing to log on this row.
            if (inserted.length === 0) continue;
            insertedIds.push(id);
            if (owner) {
                await writeTouchpoint({
                    dealerLeadId: id,
                    touchpointType: "ownership_transfer",
                    performedBy: user.id,
                    remarks: `Assigned via bulk upload (batch ${batchId}).`,
                    // ID 83: every owner has a dated reason — the hop (nobody →
                    // the assignee) is what lead tracking and the first-owner
                    // reports read; without it this owner had no start.
                    fromOwnerId: null,
                    toOwnerId: owner,
                });
                // ID 82: an upload that names an owner is an admin assignment —
                // a Sales-ready event, as on every other path that gives a lead
                // an owner. Rows uploaded with no owner are not sales-ready yet.
                await markSalesReady(db, { leadId: id, reason: "admin_assigned", actorId: user.id });
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
            known.push({ id: row.duplicate_lead_id, note: p.dealer_name });
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
            known.push({ id: row.duplicate_lead_id, note: p.dealer_name });
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
            known.push({ id: row.duplicate_lead_id, note: p.dealer_name });
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

    // ID 81. Every lead this batch created gets its source — Entered via Bulk
    // upload (the trigger already set it from the batch id), Found via, and the
    // batch's campaign — and a "Lead created" line. Every dealer the file found
    // again gets a Re-inquiry on the lead it already has. All best-effort and
    // after the import: the leads exist either way. A file that created
    // nothing (every row a known dealer) does not get a campaign of its own.
    const campaignId =
        insertedIds.length > 0 || pickedCampaignId
            ? await campaignForUploadBatch({
                  batchId,
                  fileName: b.file_name,
                  label: b.source_label ?? null,
                  origin: b.origin,
                  uploadedBy: user.id,
                  pickedCampaignId,
              })
            : null;
    await stampLeadSourceBulk(insertedIds, { door: "bulk_upload", origin: b.origin, campaignId });
    await recordLeadsCreatedBulk(insertedIds, { door: "bulk_upload", actorId: user.id });
    await recordReinquiries(known, { door: "bulk_upload", actorId: user.id });

    const summaryRows = await db.execute<UploadBatchSummary>(sql`
        SELECT batch_id, file_name, uploaded_by, NULL AS uploaded_by_name,
               total_rows, valid_rows, errored_rows, duplicate_rows,
               routing_to_ai, source_label, status, rollback_window_until,
               rolled_back_at, created_at
        FROM upload_batches WHERE batch_id = ${batchId}
    `);

    return successResponse(summaryRows[0]);
});
