// GET /api/dealer-leads/check-duplicate?phone=…&city=…
//
// Live duplicate check for the Add-Lead form, so the operator learns about a
// collision while typing rather than after submitting.
//
// NOT to be confused with /api/leads/check-duplicate, which targets the `leads`
// table — the loan-application entity — and is dealer-scoped. This one targets
// `dealer_leads`, the telecalling prospect pool, which is what the /leads page,
// the scraper, the AI dialer and NeoDove all operate on.
//
// Returns the same four-outcome classification the importers use, so the form's
// warning text and the import summary can never disagree about what a given
// phone number means.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import {
    classifyAgainstExisting,
    loadExistingByPhone,
    normalizePhone,
} from "@/lib/leads/dedupe";

export const GET = withErrorHandler(async (req: Request) => {
    await requireAuth();

    const { searchParams } = new URL(req.url);
    const rawPhone = searchParams.get("phone") ?? "";
    const city = searchParams.get("city") ?? "";

    if (!rawPhone.trim()) return errorResponse("phone is required", 400);

    const phone = normalizePhone(rawPhone);
    if (!phone) {
        return successResponse({
            valid: false,
            outcome: null,
            message: "Not a valid 10-digit Indian mobile number.",
            existing: null,
        });
    }

    const existingMap = await loadExistingByPhone([phone]);
    const existing = existingMap.get(phone);
    const { outcome, duplicateLeadId } = classifyAgainstExisting(city, existing);

    if (outcome === "valid") {
        return successResponse({
            valid: true,
            outcome,
            normalizedPhone: phone,
            message: null,
            existing: null,
        });
    }

    // Enough detail for the operator to act, without dumping the whole row.
    const detail = await db.execute<{
        id: string;
        dealer_name: string | null;
        shop_name: string | null;
        city: string | null;
        lead_status: string | null;
        current_owner_name: string | null;
    }>(sql`
        SELECT dl.id, dl.dealer_name, dl.shop_name, dl.city, dl.lead_status,
               u.name AS current_owner_name
          FROM dealer_leads dl
          LEFT JOIN users u ON u.id::text = dl.current_owner_id
         WHERE dl.id = ${duplicateLeadId} LIMIT 1
    `);

    const message =
        outcome === "reactivate"
            ? "This dealer already exists and is marked Lost — reactivate that lead instead of creating a new one."
            : outcome === "address_mismatch"
              ? "This phone belongs to an existing lead registered in a different city. Submitting will raise a merge request for an admin."
              : "A lead with this phone number is already in the system.";

    return successResponse({
        valid: false,
        outcome,
        normalizedPhone: phone,
        message,
        existing: detail[0] ?? { id: duplicateLeadId },
    });
});
