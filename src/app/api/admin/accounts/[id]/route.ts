/**
 * GET /api/admin/accounts/[id] — one dealer account for the Accounts detail
 * page: the account, its ownership (owner, onboarded by, came through), the
 * owner history windows, the linked lead and onboarding application, the
 * extra GSTINs (aliases) that also identify it, and whether a GST
 * certificate is on file (decides if Correct GSTIN needs an upload).
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ownerHistory, suggestedOwners } from "@/lib/accounts/ownership";
import {
    ACCOUNT_ADMIN_ROLES,
    GST_CERT_DOC_TYPES,
    HttpError,
    gstinMissingSql,
    requireAccountTables,
} from "../_lib";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export const GET = withErrorHandler(async (_req: Request, context: RouteContext) => {
    await requireRole(ACCOUNT_ADMIN_ROLES);
    await requireAccountTables();
    const { id } = await context.params;

    const accRows = (await db.execute(sql`
        SELECT a.id, a.business_entity_name AS name, a.gstin, a.pan,
               ${gstinMissingSql(sql`a.gstin`)} AS gstin_missing,
               a.city, a.state, a.status, a.dealer_code, a.contact_name, a.contact_phone,
               a.contact_email, a.created_at,
               o.owner_user_id::text AS owner_user_id, ou.name AS owner_name,
               o.onboarded_by_user_id::text AS onboarded_by_user_id, ob.name AS onboarded_by_name,
               o.came_through, o.source_dealer_lead_id, o.source_application_id,
               o.updated_at AS ownership_updated_at
          FROM accounts a
          LEFT JOIN account_ownership o ON o.account_id = a.id
          LEFT JOIN users ou ON ou.id = o.owner_user_id
          LEFT JOIN users ob ON ob.id = o.onboarded_by_user_id
         WHERE a.id = ${id}
         LIMIT 1
    `)) as unknown as Array<Record<string, unknown>>;
    const acc = accRows[0];
    if (!acc) throw new HttpError("Account not found", 404);

    // The onboarding application: the recorded one, else the first by dealer code.
    const appRows = (await db.execute(sql`
        SELECT app.id::text AS id, app.company_name, app.gst_number, app.onboarding_status,
               app.originating_dealer_lead_id, app.created_at
          FROM dealer_onboarding_applications app
         WHERE ${acc.source_application_id ? sql`app.id::text = ${acc.source_application_id as string}` : sql`app.dealer_code = ${id}`}
         ORDER BY app.created_at ASC
         LIMIT 1
    `)) as unknown as Array<Record<string, unknown>>;
    const app = appRows[0] ?? null;

    const leadId =
        (acc.source_dealer_lead_id as string | null) ??
        (app?.originating_dealer_lead_id as string | null) ??
        null;
    const leadRows = (await db.execute(
        leadId
            ? sql`SELECT id, COALESCE(shop_name, dealer_name) AS name, lead_status, gstin
                    FROM dealer_leads WHERE id = ${leadId} LIMIT 1`
            : app
              ? sql`SELECT id, COALESCE(shop_name, dealer_name) AS name, lead_status, gstin
                      FROM dealer_leads WHERE dealer_onboarding_application_id::text = ${app.id as string}
                      LIMIT 1`
              : sql`SELECT NULL WHERE false`,
    )) as unknown as Array<Record<string, unknown>>;
    const lead = leadRows[0] ?? null;

    const [aliases, certs, history, suggestion] = await Promise.all([
        db.execute(sql`
            SELECT g.gstin, g.source, g.created_at, u.name AS added_by_name
              FROM account_gstins g
              LEFT JOIN users u ON u.id = g.added_by
             WHERE g.account_id = ${id}
             ORDER BY g.created_at DESC
        `) as unknown as Promise<Array<Record<string, unknown>>>,
        app
            ? (db.execute(sql`
                SELECT id::text AS id, document_type, file_name, file_url, doc_status, uploaded_at
                  FROM dealer_onboarding_documents
                 WHERE application_id::text = ${app.id as string}
                   AND document_type IN (${sql.join(GST_CERT_DOC_TYPES.map((t) => sql`${t}`), sql`, `)})
                   AND doc_status <> 'superseded'
                 ORDER BY uploaded_at DESC
            `) as unknown as Promise<Array<Record<string, unknown>>>)
            : Promise.resolve([] as Array<Record<string, unknown>>),
        ownerHistory(id),
        acc.owner_user_id ? Promise.resolve(null) : suggestedOwners([id]).then((m) => m.get(id) ?? null),
    ]);

    return successResponse({
        account: {
            ...acc,
            gstin_missing: Boolean(acc.gstin_missing),
            created_at: iso(acc.created_at),
            ownership_updated_at: iso(acc.ownership_updated_at),
        },
        application: app ? { ...app, created_at: iso(app.created_at) } : null,
        lead,
        gstin_aliases: aliases.map((a) => ({ ...a, created_at: iso(a.created_at) })),
        gst_certificates: certs.map((c) => ({ ...c, uploaded_at: iso(c.uploaded_at) })),
        has_gst_certificate: certs.length > 0,
        owner_history: history.map((h) => ({
            ...h,
            effective_from: iso(h.effective_from),
            effective_to: iso(h.effective_to),
            created_at: iso(h.created_at),
        })),
        suggested_owner: suggestion,
    });
});
