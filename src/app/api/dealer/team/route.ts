// E-277 — dealer-portal Team API: the dealer's WhatsApp salespersons.
// Same CRUD module as the WhatsApp "My Team" chat menu (src/lib/team/
// salespersons.ts) so the two surfaces cannot drift.

import { z } from "zod";

import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { createClient } from "@/lib/supabase/server";
import { resolveDealerProfile } from "@/lib/supabase/identity";
import { addSalesperson, listTeam, type AddConflict } from "@/lib/team/salespersons";

const addSchema = z.object({
  phone: z.string().min(10).max(20),
  name: z.string().trim().min(2).max(80),
});

const CONFLICT_MESSAGES: Record<AddConflict, string> = {
  invalid_phone: "That doesn't look like a valid mobile number (10 digits expected).",
  already_salesperson_here: "That number is already on your team.",
  already_salesperson_elsewhere:
    "That number is already registered as a salesperson with another dealer.",
  is_operator: "That number belongs to an iTarang team member.",
  is_dealer: "That number belongs to a registered dealer.",
  is_own_number: "That's your own number — you already have full access.",
};

async function requireDealer() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return null;
  const profile = await resolveDealerProfile(supabase, user, "id,email,role,dealer_id");
  if (!profile?.dealer_id) return null;
  return profile;
}

export const GET = withErrorHandler(async () => {
  const profile = await requireDealer();
  if (!profile) return errorResponse("Unauthorized", 401);
  const team = await listTeam(profile.dealer_id, { includeInactive: true });
  return successResponse({ team });
});

export const POST = withErrorHandler(async (req: Request) => {
  const profile = await requireDealer();
  if (!profile) return errorResponse("Unauthorized", 401);

  const parsed = addSchema.safeParse(await req.json());
  if (!parsed.success) {
    return errorResponse("Invalid input: phone (10 digits) and name are required", 400);
  }

  const result = await addSalesperson({
    dealerCode: profile.dealer_id,
    phone: parsed.data.phone,
    displayName: parsed.data.name,
    addedBy: profile.id ?? null,
    addedVia: "portal",
  });

  if (!result.ok) {
    return errorResponse(CONFLICT_MESSAGES[result.reason], result.reason === "invalid_phone" ? 400 : 409);
  }
  return successResponse({ member: result.member });
});
