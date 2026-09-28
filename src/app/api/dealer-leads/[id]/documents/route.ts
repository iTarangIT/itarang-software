/**
 * GET /api/dealer-leads/[id]/documents → { success, data: LeadDocuments }
 *
 * The lead page's "Documents & photos" tab (E-311): documents filed on the
 * dealer lead (dealer_lead_documents — today from the WhatsApp Assistant) and
 * the photos on its visits (lead_visits.photos, from the ASM visit screen or
 * the assistant). Read-only.
 *
 * Access: the same two tiers as Lead Tracking (LEAD_TRACKING_ROLES):
 *   admin / ceo / sales_head      any lead.
 *   inside_sales_rep / asm        only leads they have handled.
 * Files open through /api/files, which requires a session for `documents`.
 *
 * A host without E-311 has no dealer_lead_documents table: the tab then shows
 * the visit photos alone (to_regclass guard) instead of failing.
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { withErrorHandler, errorResponse, successResponse } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LEAD_TRACKING_OWN_ONLY_ROLES, LEAD_TRACKING_ROLES } from "@/lib/leads/access";
import { canViewLeadTracking } from "@/lib/leads/tracking";
import { mediaUrl } from "@/lib/assistant/media";

export const dynamic = "force-dynamic";

export type LeadDocumentItem = {
    id: string;
    doc_type: string;
    url: string;
    mime_type: string | null;
    file_name: string | null;
    note: string | null;
    source: string;
    uploaded_by_name: string | null;
    created_at: string;
};

export type LeadVisitPhoto = {
    visit_id: string;
    url: string;
    visit_date: string | null;
    asm_name: string | null;
};

export type LeadDocuments = { documents: LeadDocumentItem[]; visit_photos: LeadVisitPhoto[] };

export const GET = withErrorHandler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole([...LEAD_TRACKING_ROLES]);
    const { id } = await ctx.params;
    if (!id) return errorResponse("Lead id required", 400);
    if ((LEAD_TRACKING_OWN_ONLY_ROLES as readonly string[]).includes(user.role)) {
        if (!(await canViewLeadTracking(user.id, id))) {
            return errorResponse("You can only see documents on leads you have handled.", 403);
        }
    }

    const [{ has_docs }] = await db.execute<{ has_docs: boolean }>(
        sql`SELECT to_regclass('public.dealer_lead_documents') IS NOT NULL AS has_docs`,
    );
    const docRows = has_docs
        ? await db.execute<{
              id: string;
              doc_type: string;
              storage_bucket: string;
              storage_key: string;
              mime_type: string | null;
              file_name: string | null;
              note: string | null;
              source: string;
              uploaded_by_name: string | null;
              created_at: string | Date;
          }>(sql`
              SELECT d.id::text, d.doc_type, d.storage_bucket, d.storage_key, d.mime_type, d.file_name, d.note,
                     d.source, u.name AS uploaded_by_name, d.created_at
                FROM dealer_lead_documents d
                LEFT JOIN users u ON u.id = d.uploaded_by
               WHERE d.dealer_lead_id = ${id}
               ORDER BY d.created_at DESC
               LIMIT 200
          `)
        : [];

    const visitRows = await db.execute<{
        visit_id: string;
        photos: unknown;
        visit_date: string | Date | null;
        asm_name: string | null;
    }>(sql`
        SELECT v.visit_id::text, v.photos, COALESCE(v.actual_visit_date, v.created_at::date) AS visit_date, u.name AS asm_name
          FROM lead_visits v
          LEFT JOIN users u ON u.id::text = v.asm_id
         WHERE v.dealer_lead_id = ${id} AND jsonb_array_length(COALESCE(v.photos, '[]'::jsonb)) > 0
         ORDER BY v.created_at DESC
         LIMIT 100
    `);

    const iso = (d: string | Date | null) => (d == null ? null : new Date(d).toISOString());
    const data: LeadDocuments = {
        documents: docRows.map((r) => ({
            id: r.id,
            doc_type: r.doc_type,
            url: mediaUrl(r.storage_bucket, r.storage_key),
            mime_type: r.mime_type,
            file_name: r.file_name,
            note: r.note,
            source: r.source,
            uploaded_by_name: r.uploaded_by_name,
            created_at: iso(r.created_at)!,
        })),
        visit_photos: visitRows.flatMap((v) =>
            (Array.isArray(v.photos) ? v.photos : [])
                .filter((p): p is string => typeof p === "string" && p.length > 0)
                .map((url) => ({
                    visit_id: v.visit_id,
                    url,
                    visit_date: iso(v.visit_date)?.slice(0, 10) ?? null,
                    asm_name: v.asm_name,
                })),
        ),
    };
    return successResponse(data);
});
