// POST /api/inside-sales/lead/create
// Lightweight manual lead entry for the Inside Sales workspace. The write lives
// in lib/inside-sales/createLead.ts, shared with the WhatsApp Assistant:
// Inside Sales / admin → New_Unassigned in the claim pool; ASM / partner →
// owned by the creator.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { BusinessTypeSchema } from "@/lib/leads/businessType";
import { createInsideSalesLead, DuplicatePhoneError } from "@/lib/inside-sales/createLead";

const MUTATE_ROLES = ["inside_sales_rep", "asm", "admin", "partner"];

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
    // E-296 "Type of Business". Optional; "" = not set.
    business_type: z.union([BusinessTypeSchema, z.literal("")]).optional().nullable(),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(MUTATE_ROLES);
    const body = BodySchema.parse(await req.json());

    let created;
    try {
        created = await createInsideSalesLead({
            actor: { id: user.id, role: user.role },
            dealerName: body.dealer_name,
            phone: body.phone,
            shopName: body.shop_name,
            city: body.city,
            state: body.state,
            interestLevel: body.interest_level,
            language: body.language,
            businessType: body.business_type,
        });
    } catch (err) {
        if (err instanceof DuplicatePhoneError) return errorResponse(err.message, 409);
        throw err;
    }
    await created.afterCommit();

    return successResponse({
        id: created.id,
        ...(created.businessTypeSaved !== undefined ? { business_type_saved: created.businessTypeSaved } : {}),
    });
});
