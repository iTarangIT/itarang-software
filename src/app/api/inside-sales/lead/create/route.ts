// POST /api/inside-sales/lead/create
// Lightweight manual lead entry for the Inside Sales workspace. Inserts a
// dealer_leads row as New_Unassigned with no owner, so the lead lands straight
// in the "Unassigned (Claim)" queue for any rep to pick up. Mirrors the column
// conventions of /api/dealer-leads (id = DL-<ts>-<nanoid>, phone UNIQUE) plus
// the BRD §0.7 lifecycle status the queues filter on.

import { nanoid } from "nanoid";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";

const MUTATE_ROLES = ["inside_sales_rep", "admin"];

const BodySchema = z.object({
    dealer_name: z.string().trim().min(2).max(200),
    shop_name: z.string().trim().max(200).optional().nullable(),
    phone: z
        .string()
        .trim()
        .regex(/^\d{10}$/, "Phone must be exactly 10 digits"),
    city: z.string().trim().max(120).optional().nullable(),
    state: z.string().trim().max(120).optional().nullable(),
    interest_level: z.enum(["hot", "warm", "cold"]).optional().nullable(),
    language: z.string().trim().max(40).optional().nullable(),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(MUTATE_ROLES);
    const body = BodySchema.parse(await req.json());

    // Phone is UNIQUE on dealer_leads — reject duplicates with a clear 409.
    const existing = await db
        .select({ id: dealerLeads.id })
        .from(dealerLeads)
        .where(sql`${dealerLeads.phone} = ${body.phone}`)
        .limit(1);
    if (existing.length > 0) {
        return errorResponse("A lead with this phone number already exists.", 409);
    }

    const id = `DL-${Date.now()}-${nanoid(8)}`;
    const now = new Date();

    try {
        await db.insert(dealerLeads).values({
            id,
            dealer_name: body.dealer_name,
            phone: body.phone,
            shop_name: body.shop_name || null,
            city: body.city || null,
            state: body.state || null,
            location: body.city || null,
            language: body.language || "hindi",
            interest_level: body.interest_level || null,
            // Land in the claim queue: a real lifecycle status, no owner.
            lead_status: "New_Unassigned",
            current_status: "new",
            source: "manual_upload_lead",
            originator_id: user.id,
            current_owner_id: null,
            is_active: true,
            total_attempts: 0,
            final_intent_score: 0,
            follow_up_history: [],
            created_at: now,
            updated_at: now,
        });
    } catch (err) {
        const e = err as { code?: string; message?: string };
        if (e.code === "23505" || e.message?.includes("unique")) {
            return errorResponse("A lead with this phone number already exists.", 409);
        }
        throw err;
    }

    return successResponse({ id });
});
