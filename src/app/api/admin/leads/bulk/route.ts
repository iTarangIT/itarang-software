// POST /api/admin/leads/bulk — BRD §0.11 admin bulk actions. Explicitly an
// admin operation (the documented exception to the single-owner rule, §0.12).
// One audited touchpoint per affected lead.
//
// Actions: reassign · mark_lost · push_to_ai · reactivate · export(CSV) ·
// export_touchpoints(XLSX) · export_tracking(CSV, E-295 lead journey) ·
// set_business_type (E-296 "Type of Business").

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import { StatusGuardError, writeTouchpoint } from "@/lib/touchpoints/write";
import {
    CompetitorRequiredError,
    HighImpactUnconfirmedError,
    LostNotesRequiredError,
    checkMarkLost,
    markLeadLost,
} from "@/lib/leads/markLost";
import { buildTouchpointWorkbook } from "@/lib/leads/touchpointWorkbook";
import { buildLeadTracking } from "@/lib/leads/tracking";
import { trackingCsvResponse } from "@/lib/leads/trackingCsv";
import { reactivateLead } from "@/lib/leads/reactivation";
import { assignLeadOwner, resolveAssignTarget } from "@/lib/leads/assignOwner";
import {
    LOST_REASON,
    isOpen,
    type LeadStatus,
} from "@/lib/lifecycle/transitions";
import { checkStatusMove } from "@/lib/lifecycle/statusRules";
import { BusinessTypeSchema } from "@/lib/leads/businessType";
import { exportsOwnLeadsOnly, logDataDownload } from "@/lib/exports/downloadLog";

export const dynamic = "force-dynamic";
// 300, not 60: export_touchpoints may assemble a workbook for up to 5,000 leads
// and their whole activity log, which is well past what 60s comfortably covers.
export const maxDuration = 300;

// ⚠ MUST stay equal to LEADS_BULK_ROLES in src/lib/leads/access.ts — that list
// decides whether the bulk bar renders, this one decides whether it works.
const MUTATE_ROLES = ["admin", "sales_head", "ceo", "partner"];

const BodySchema = z.object({
    action: z.enum([
        "reassign",
        "mark_lost",
        "push_to_ai",
        "reactivate",
        "export",
        "export_touchpoints",
        "export_tracking",
        "set_business_type",
    ]),
    lead_ids: z.array(z.string().min(1)).min(1).max(5000),
    target_user_id: z.string().min(1).optional(),
    lost_reason: z.enum(LOST_REASON).optional(),
    reason: z.string().trim().max(2000).optional(),
    // mark_lost only — the same two answers the single-lead Mark Lost asks for.
    competitor_name: z.string().trim().max(200).nullable().optional(),
    confirmed_high_impact: z.boolean().optional(),
    // set_business_type only. null clears the type ("Not set").
    business_type: BusinessTypeSchema.nullable().optional(),
});

function csvEscape(v: unknown): string {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(MUTATE_ROLES);
    const body = BodySchema.parse(await req.json());
    const ids = body.lead_ids;

    // ID 58 — the three exports below hand lead data out as a file, so they
    // follow the export rule, not the bulk-action rule: a role whose exports
    // are limited to its own leads (OWN_LEADS_EXPORT_ROLES — here, partner)
    // gets only the selected leads it owns, and every download is logged.
    const isExport =
        body.action === "export" ||
        body.action === "export_touchpoints" ||
        body.action === "export_tracking";
    const ownOnly = isExport && exportsOwnLeadsOnly(user.role);
    let exportIds = ids;
    if (ownOnly) {
        const owned = (await db.execute<{ id: string }>(sql`
            SELECT id FROM dealer_leads WHERE id IN ${ids} AND current_owner_id = ${user.id}
        `)) as unknown as { id: string }[];
        exportIds = owned.map((r) => r.id);
        if (exportIds.length === 0) {
            return errorResponse("You can export your own leads only — none of the selected leads are yours.", 403);
        }
    }
    const logExport = (dataset: string, rowCount: number) =>
        logDataDownload({
            userId: user.id,
            role: user.role,
            dataset,
            rowCount,
            ownOnly,
            filters: { selected: ids.length, exported: exportIds.length },
        });

    // ── Export — return a CSV download. ────────────────────────────────────
    if (body.action === "export") {
        const rows = await db.execute<Record<string, unknown>>(sql`
            SELECT dl.phone, dl.dealer_name, dl.city, dl.state, dl.lead_status,
                   dl.interest_level, dl.final_intent_score, dl.source,
                   ow.name AS owner_name, dl.created_at
            FROM dealer_leads dl
            LEFT JOIN users ow ON ow.id::text = dl.current_owner_id
            WHERE dl.id IN ${exportIds}
            ORDER BY dl.created_at DESC
        `);
        await logExport("leads_bulk_csv", rows.length);
        const headers = [
            "phone",
            "dealer_name",
            "city",
            "state",
            "lead_status",
            "interest_level",
            "final_intent_score",
            "source",
            "owner_name",
            "created_at",
        ];
        const lines = [
            headers.join(","),
            ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(",")),
        ];
        return new Response(lines.join("\r\n"), {
            headers: {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": `attachment; filename="leads_export.csv"`,
            },
        });
    }

    // ── Export touchpoints — return an .xlsx download. ─────────────────────
    // Read-only, like `export` above: it must return BEFORE the mutating paths,
    // and it writes no touchpoint of its own (exporting the log is not an event
    // in the log).
    if (body.action === "export_touchpoints") {
        const workbook = await buildTouchpointWorkbook(exportIds);
        const buffer = await workbook.xlsx.writeBuffer();
        await logExport("leads_bulk_touchpoints", exportIds.length);
        return new Response(Buffer.from(buffer), {
            status: 200,
            headers: {
                "Content-Type":
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "Content-Disposition":
                    'attachment; filename="lead_touchpoint_history.xlsx"',
                "Content-Length": buffer.byteLength.toString(),
                "Cache-Control": "no-store",
            },
        });
    }

    // ── Export lead tracking — one CSV of every selected lead's journey. ───
    // Read-only like the two above. Leads come out in the order the tracking
    // builder returns them; rows inside a lead run oldest-first.
    if (body.action === "export_tracking") {
        const trackings = await buildLeadTracking(exportIds);
        await logExport("leads_bulk_tracking", trackings.size);
        return trackingCsvResponse([...trackings.values()], "lead-tracking");
    }

    // ── Set Type of Business (E-296). ──────────────────────────────────────
    // A profile field, not a lifecycle event — so, like PATCH /api/dealer-leads
    // /[id], it writes NO touchpoint (it is not an interaction with the dealer
    // and would inflate the §0.11 touchpoint counts). One raw UPDATE: the column
    // is not on the Drizzle object (see schema.ts).
    if (body.action === "set_business_type") {
        if (body.business_type === undefined) {
            return errorResponse(
                "business_type is required (null to clear).",
                400,
            );
        }
        try {
            const updated = (await db.execute<{ id: string }>(sql`
                UPDATE dealer_leads
                   SET business_type = ${body.business_type},
                       updated_at = NOW()
                 WHERE id IN ${ids}
                   AND is_active IS NOT FALSE
                RETURNING id
            `)) as unknown as { id: string }[];
            return successResponse({
                ok: true,
                affected: updated.length,
                skipped: ids.length - updated.length,
            });
        } catch (e) {
            const err = e as { message?: string; cause?: { message?: string } };
            const msg = `${err.message ?? ""} ${err.cause?.message ?? ""}`;
            if (msg.includes("business_type")) {
                return errorResponse(
                    "Type of Business is not available on this database yet (migration E-296 not applied).",
                    409,
                );
            }
            throw e;
        }
    }

    // Load the selected leads' current state.
    const leads = (await db.execute<{
        id: string;
        lead_status: string | null;
    }>(sql`
        SELECT id, lead_status FROM dealer_leads WHERE id IN ${ids}
    `)) as unknown as { id: string; lead_status: string | null }[];

    let affected = 0;
    let skipped = 0;
    // Of `skipped`: Won leads a bulk Mark Lost left alone (ID 115).
    let skippedWon = 0;
    // Of `skipped`: Awaiting-field-visit leads a reassign left with the ASM (ID 121).
    let skippedVisitBooked = 0;
    const reactivated: Array<{ id: string } & Awaited<ReturnType<typeof reactivateLead>>> = [];

    if (body.action === "reassign") {
        if (!body.target_user_id) {
            return errorResponse("target_user_id is required to reassign.", 400);
        }
        const resolved = await resolveAssignTarget(body.target_user_id);
        if (!resolved.ok) {
            return errorResponse(resolved.message, resolved.status);
        }
        const target = resolved.target;
        const remarks = body.reason ?? "Bulk reassign (admin).";

        // Reassign isn't just "swap the owner": for the lead to actually land
        // on the new owner's workspace, both asm_id (for ASMs) and lead_status
        // need to match what those queues filter on. That role-dependent
        // sequence now lives in assignLeadOwner() — shared with the NeoDove
        // push, which needs byte-identical semantics so a lead handed to a
        // calling campaign lands on the same queue an admin reassign would put
        // it on. See src/lib/leads/assignOwner.ts for the full rationale.
        for (const lead of leads) {
            const outcome = await assignLeadOwner({
                leadId: lead.id,
                fromStatus: lead.lead_status as LeadStatus | null,
                target,
                actorId: user.id,
                actorRole: user.role,
                remarks,
            });
            // ID 121: an Awaiting-field-visit lead stays with the ASM while a
            // visit is booked. One lead (drawer, Converted card) → the reason
            // as an error, so the screen does not say "reassigned".
            if (outcome.path === "handback_blocked") {
                if (leads.length === 1) return errorResponse(outcome.blockedReason ?? "The ASM has a visit booked.", 409);
                skipped++;
                skippedVisitBooked++;
                continue;
            }
            affected++;
        }
    } else if (body.action === "mark_lost") {
        if (!body.lost_reason) {
            return errorResponse("lost_reason is required to mark lost.", 400);
        }
        // ID 57 — a lead is lost the same way from every entry point: the
        // single-lead Mark Lost rules (notes for "other", the competitor for
        // "lost to competition", an explicit confirmation for a high-impact
        // reason) and its side effects (competitor name stored, a closed
        // business excluded from the AI dialer) through the one writer.
        const lost = {
            reason: body.lost_reason,
            notes: body.reason ?? null,
            confirmedHighImpact: body.confirmed_high_impact,
            competitorName: body.competitor_name ?? null,
        };
        try {
            checkMarkLost(lost);
        } catch (err) {
            if (
                err instanceof LostNotesRequiredError ||
                err instanceof HighImpactUnconfirmedError ||
                err instanceof CompetitorRequiredError
            ) {
                return errorResponse(err.message, 400);
            }
            throw err;
        }
        for (const lead of leads) {
            const status = lead.lead_status as LeadStatus | null;
            if (!status || !isOpen(status)) {
                skipped++;
                continue;
            }
            // ID 115: ask the status guard BEFORE writing. A Won lead is open
            // but can be marked Lost only through the onboarding drop-out
            // review, so the writer refuses it — and a refusal thrown mid-loop
            // left the leads before it Lost and the rest untouched. It is
            // skipped and counted instead, and the batch carries on.
            if (!checkStatusMove({ from: status, to: "Lost", event: "mark_lost" }).ok) {
                skipped++;
                if (status === "Won") skippedWon++;
                continue;
            }
            try {
                await markLeadLost({
                    leadId: lead.id,
                    actor: { id: user.id, role: user.role },
                    ...lost,
                    notes: body.reason ?? "Bulk mark lost (admin).",
                    closingRole: "admin",
                });
            } catch (err) {
                // The status was read before the loop; a lead marked Won (or
                // closed) since then is refused by the writer on its locked
                // row. Each lead is its own transaction, so that one is left
                // as it was and the rest of the batch still runs.
                if (err instanceof StatusGuardError) {
                    skipped++;
                    continue;
                }
                throw err;
            }
            affected++;
        }
    } else if (body.action === "push_to_ai") {
        // BRD §0.2 — only Lost leads enter the AI re-engagement queue.
        for (const lead of leads) {
            if (lead.lead_status !== "Lost") {
                skipped++;
                continue;
            }
            await db.execute(sql`
                UPDATE dealer_leads
                SET ai_recall_status = 'awaiting_re_dial', updated_at = NOW()
                WHERE id = ${lead.id}
            `);
            await writeTouchpoint({
                dealerLeadId: lead.id,
                touchpointType: "ai_dialer_admin_push",
                performedBy: user.id,
                remarks:
                    body.reason ??
                    "Pushed to AI dialer for re-engagement (admin).",
            });
            affected++;
        }
    } else if (body.action === "reactivate") {
        // BRD §0.9 — manual reactivation of Lost leads.
        for (const lead of leads) {
            if (lead.lead_status !== "Lost") {
                skipped++;
                continue;
            }
            const r = await reactivateLead({
                leadId: lead.id,
                trigger: "admin",
                performedBy: user.id,
                notes: body.reason ?? "Manual reactivation (admin).",
            });
            reactivated.push({ id: lead.id, ...r });
            affected++;
        }
    }

    return successResponse({
        ok: true,
        affected,
        skipped,
        skipped_won: skippedWon,
        skipped_visit_booked: skippedVisitBooked,
        // reactivate only: where each lead went (owner back, or the unassigned pool).
        ...(body.action === "reactivate" ? { reactivated } : {}),
    });
});
