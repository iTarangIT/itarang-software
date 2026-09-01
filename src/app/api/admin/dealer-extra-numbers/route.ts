// GET  /api/admin/dealer-extra-numbers — extra main-dealer numbers (+ dealer names)
// POST /api/admin/dealer-extra-numbers — register an extra main number for a dealer
//
// E-279. An "extra number" is an ADDITIONAL WhatsApp number that acts as the
// full main-dealer console for one dealership (admin "Multiple dealer" tab).
// All identity semantics live in src/lib/team/extra-numbers.ts; this route is
// auth + validation + friendly conflict messages, mirroring the E-214
// whatsapp-operators route. Conflicts are terminal here — no allowDealerNumber
// override, because a double identity would misroute leads.

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { dealers } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import {
  errorResponse,
  successResponse,
  withErrorHandler,
} from "@/lib/api-utils";
import {
  addExtraNumber,
  CONFLICT_MESSAGES,
  listExtraNumbers,
} from "@/lib/team/extra-numbers";

const READ_ROLES = ["admin", "sales_head", "ceo"];
const WRITE_ROLES = ["admin", "sales_head"];

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole(READ_ROLES);

  const url = new URL(req.url);
  const dealerCode = url.searchParams.get("dealerCode")?.trim() || null;

  const numbers = await listExtraNumbers(dealerCode, { includeInactive: true });

  // Resolve dealer display names in one pass (loose varchar ref, no join key
  // guarantees) so the table and the read-only CEO view need no second call.
  const codes = [...new Set(numbers.map((n) => n.dealerCode))];
  const nameByCode = new Map<string, string>();
  if (codes.length > 0) {
    const rows = await db
      .select({
        dealerCode: dealers.dealer_id,
        companyName: dealers.company_name,
        ownerName: dealers.owner_name,
      })
      .from(dealers)
      .where(inArray(dealers.dealer_id, codes));
    for (const r of rows) {
      if (r.dealerCode) {
        nameByCode.set(r.dealerCode, r.companyName || r.ownerName || "");
      }
    }
  }

  return successResponse({
    numbers: numbers.map((n) => ({
      ...n,
      dealerName: nameByCode.get(n.dealerCode) || null,
    })),
  });
});

export const POST = withErrorHandler(async (req: Request) => {
  const actor = await requireRole(WRITE_ROLES);
  const body = await req.json().catch(() => ({}));

  const dealerCode = String(body?.dealerCode ?? "").trim();
  const rawPhone = String(body?.waPhone ?? "").trim();
  const displayName = String(body?.displayName ?? "").trim();
  const notes = String(body?.notes ?? "").trim() || null;

  if (!dealerCode) return errorResponse("Select a dealer", 400);
  if (!displayName) return errorResponse("Name is required", 400);
  if (!rawPhone) return errorResponse("Enter a WhatsApp number", 400);

  // The dealership must exist and be active — an extra number for a suspended
  // dealer would open a console the primary number no longer has.
  const [dealer] = await db
    .select({ id: dealers.dealer_id, companyName: dealers.company_name })
    .from(dealers)
    .where(
      and(
        eq(dealers.dealer_id, dealerCode),
        eq(dealers.onboarding_status, "active"),
      ),
    )
    .limit(1);
  if (!dealer) {
    return errorResponse("That dealer is not active (or doesn't exist).", 400);
  }

  const result = await addExtraNumber({
    dealerCode,
    phone: rawPhone,
    displayName,
    addedBy: actor.id,
    notes,
  });
  if (!result.ok) {
    const status = result.reason === "invalid_phone" ? 400 : 409;
    return errorResponse(CONFLICT_MESSAGES[result.reason], status);
  }

  return successResponse({ number: result.number }, 201);
});
