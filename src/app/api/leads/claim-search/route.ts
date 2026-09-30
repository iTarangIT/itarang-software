// GET /api/leads/claim-search?mobiles=9876543210,9123456789
//
// Tracker ID 45 / 46 (handover P0-2). A rep never lists the unowned pool: they
// type one mobile number, or several separated by commas, and see ONLY the
// leads whose number matches — each with whether they can claim it. Matched on
// the last 10 digits, the same idiom as the shared duplicate check
// (loadExistingByPhone), because dealer_leads.phone is stored in mixed formats.
//
// An ASM also sees whether the lead is inside their territory; a claim outside
// it is allowed and marked for the Sales Head (claimLead).

import { sql } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { CLAIM_ROLES } from "@/lib/inside-sales/claimLead";
import { parseMobileList } from "@/lib/leads/claimScope";

export const dynamic = "force-dynamic";

export type ClaimSearchRow = {
    id: string;
    dealer_name: string | null;
    shop_name: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    lead_status: string | null;
    owner_name: string | null;
    owned_by_me: boolean;
    claimable: boolean;
    /** Null for roles without a territory. */
    in_territory: boolean | null;
    matched: string;
};

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole([...CLAIM_ROLES]);
    const raw = new URL(req.url).searchParams.get("mobiles") ?? "";
    const { mobiles, invalid } = parseMobileList(raw);
    if (mobiles.length === 0) {
        return errorResponse("Enter at least one valid 10-digit mobile number.", 400);
    }

    const isAsm = user.role === "asm";
    const rows = (await db.execute<ClaimSearchRow>(sql`
        SELECT dl.id, dl.dealer_name, dl.shop_name, dl.phone, dl.city, dl.state, dl.lead_status,
               u.name AS owner_name,
               (dl.current_owner_id = ${user.id}) AS owned_by_me,
               (dl.current_owner_id IS NULL
                 AND dl.lead_status IS DISTINCT FROM 'Converted'
                 AND dl.lead_status IS DISTINCT FROM 'Lost'
                 AND dl.is_active IS NOT FALSE) AS claimable,
               ${
                   isAsm
                       ? sql`EXISTS (
                            SELECT 1 FROM asm_territories t
                             WHERE t.asm_id = ${user.id}
                               AND t.state = dl.state
                               AND (t.city IS NULL OR t.city = dl.city)
                               AND (t.active_from IS NULL OR t.active_from <= CURRENT_DATE)
                               AND (t.active_to IS NULL OR t.active_to >= CURRENT_DATE))`
                       : sql`NULL::boolean`
               } AS in_territory,
               right(regexp_replace(dl.phone, '[^0-9]', '', 'g'), 10) AS matched
          FROM dealer_leads dl
          LEFT JOIN users u ON u.id::text = dl.current_owner_id
         WHERE right(regexp_replace(dl.phone, '[^0-9]', '', 'g'), 10) IN (
                SELECT jsonb_array_elements_text(${JSON.stringify(mobiles)}::jsonb))
         ORDER BY dl.created_at ASC
         LIMIT 100
    `)) as unknown as ClaimSearchRow[];

    const found = new Set(rows.map((r) => r.matched));
    return successResponse({
        rows,
        not_found: mobiles.filter((m) => !found.has(m)),
        invalid,
    });
});
