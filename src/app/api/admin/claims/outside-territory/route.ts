// GET /api/admin/claims/outside-territory — ASM claims made outside the ASM's
// own territory in the last 30 days (tracker ID 45: allowed, but flagged on the
// Sales Head view). Read from the claim touchpoint claimLead marks.

import { sql } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { OUTSIDE_TERRITORY_MARKER } from "@/lib/leads/claimScope";

export const dynamic = "force-dynamic";

const READ_ROLES = ["admin", "ceo", "sales_head", "sales_manager", "business_head"];

export const GET = withErrorHandler(async () => {
    await requireRole(READ_ROLES);
    const rows = await db.execute<{
        lead_id: string;
        dealer_name: string | null;
        city: string | null;
        state: string | null;
        claimed_by: string | null;
        claimed_at: string;
    }>(sql`
        SELECT t.dealer_lead_id AS lead_id,
               COALESCE(dl.dealer_name, dl.shop_name) AS dealer_name,
               dl.city, dl.state,
               u.name AS claimed_by,
               t.performed_at::text AS claimed_at
          FROM lead_touchpoints t
          JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
          LEFT JOIN users u ON u.id::text = t.performed_by
         WHERE t.touchpoint_type = 'lead_claimed'
           AND t.remarks LIKE ${"%" + OUTSIDE_TERRITORY_MARKER + "%"}
           AND t.performed_at >= NOW() - INTERVAL '30 days'
         ORDER BY t.performed_at DESC
         LIMIT 50
    `);
    return successResponse({ rows });
});
