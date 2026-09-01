// E-277 — remove (deactivate) one salesperson. Scoped: deactivateSalesperson
// matches dealer_code, so a dealer can only remove members of their own team.

import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { createClient } from "@/lib/supabase/server";
import { resolveDealerProfile } from "@/lib/supabase/identity";
import { deactivateSalesperson } from "@/lib/team/salespersons";

export const DELETE = withErrorHandler(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const supabase = await createClient();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    if (error || !user) return errorResponse("Unauthorized", 401);
    const profile = await resolveDealerProfile(supabase, user, "id,email,role,dealer_id");
    if (!profile?.dealer_id) return errorResponse("Unauthorized", 401);

    const { id } = await params;
    const removed = await deactivateSalesperson({
      dealerCode: profile.dealer_id,
      salespersonId: id,
      deactivatedBy: profile.id ?? null,
    });
    if (!removed) {
      return errorResponse("Salesperson not found on your team", 404);
    }
    return successResponse({ member: removed });
  },
);
