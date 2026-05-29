// POST /api/admin/leads/bulk — BRD §0.11 admin bulk actions. Explicitly an
// admin operation (the documented exception to the single-owner rule, §0.12).
// One audited touchpoint per affected lead.
//
// Actions: reassign · mark_lost · push_to_ai · reactivate · export(CSV).

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { reactivateLead } from "@/lib/leads/reactivation";
import { LOST_REASON, isOpen, type LeadStatus } from "@/lib/lifecycle/transitions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MUTATE_ROLES = ["admin", "sales_head"];

const BodySchema = z.object({
    action: z.enum(["reassign", "mark_lost", "push_to_ai", "reactivate", "export"]),
    lead_ids: z.array(z.string().min(1)).min(1).max(5000),
    target_user_id: z.string().min(1).optional(),
    lost_reason: z.enum(LOST_REASON).optional(),
    reason: z.string().trim().max(2000).optional(),
});

function csvEscape(v: unknown): string {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(MUTATE_ROLES);
    const body = BodySchema.parse(await req.json());
    const ids = body.lead_ids;

    // ── Export — return a CSV download. ────────────────────────────────────
    if (body.action === "export") {
        const rows = await db.execute<Record<string, unknown>>(sql`
            SELECT dl.phone, dl.dealer_name, dl.city, dl.state, dl.lead_status,
                   dl.interest_level, dl.final_intent_score, dl.source,
                   ow.name AS owner_name, dl.created_at
            FROM dealer_leads dl
            LEFT JOIN users ow ON ow.id::text = dl.current_owner_id
            WHERE dl.id IN ${ids}
            ORDER BY dl.created_at DESC
        `);
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

    // Load the selected leads' current state.
    const leads = (await db.execute<{
        id: string;
        lead_status: string | null;
    }>(sql`
        SELECT id, lead_status FROM dealer_leads WHERE id IN ${ids}
    `)) as unknown as { id: string; lead_status: string | null }[];

    let affected = 0;
    let skipped = 0;

    if (body.action === "reassign") {
        if (!body.target_user_id) {
            return errorResponse("target_user_id is required to reassign.", 400);
        }
        const targets = await db.execute<{ id: string; is_active: boolean | null }>(sql`
            SELECT id::text AS id, is_active FROM users
            WHERE id::text = ${body.target_user_id} LIMIT 1
        `);
        if (!targets[0]) return errorResponse("Target user not found.", 404);
        if (targets[0].is_active === false) {
            return errorResponse("Target user is inactive.", 400);
        }
        for (const lead of leads) {
            await db.execute(sql`
                UPDATE dealer_leads
                SET current_owner_id = ${body.target_user_id},
                    assigned_at = NOW(), updated_at = NOW()
                WHERE id = ${lead.id}
            `);
            await writeTouchpoint({
                dealerLeadId: lead.id,
                touchpointType: "ownership_transfer",
                performedBy: user.id,
                remarks: body.reason ?? "Bulk reassign (admin).",
            });
            affected++;
        }
    } else if (body.action === "mark_lost") {
        if (!body.lost_reason) {
            return errorResponse("lost_reason is required to mark lost.", 400);
        }
        for (const lead of leads) {
            const status = lead.lead_status as LeadStatus | null;
            if (!status || !isOpen(status)) {
                skipped++;
                continue;
            }
            await writeTouchpoint({
                dealerLeadId: lead.id,
                touchpointType: "status_change_note",
                performedBy: user.id,
                remarks: body.reason ?? "Bulk mark lost (admin).",
                statusChange: {
                    from: status,
                    to: "Lost",
                    toLostReason: body.lost_reason,
                    closingRole: "admin",
                    reasonNotes: body.reason ?? "Bulk mark lost (admin).",
                },
            });
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
            await reactivateLead({
                leadId: lead.id,
                trigger: "admin",
                performedBy: user.id,
                notes: body.reason ?? "Manual reactivation (admin).",
            });
            affected++;
        }
    }

    return successResponse({ ok: true, affected, skipped });
});
