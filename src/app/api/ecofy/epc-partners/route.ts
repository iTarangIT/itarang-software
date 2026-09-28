// E-307 — EPC partners ("EPC agents") from the CRM.
//
// GET  → every EPC partner in Ecofy's master (active and inactive), uncached
//        so a list page is always current.
// POST → add one. Sales Head, ASM and ISR may all do it: the call runs as
//        Ecofy's integration user (an iTarang Admin there), which is the role
//        Ecofy requires for POST /epc-partners. The CRM person is kept in the
//        outbound ledger (ecofy_sync_events.payload.actorName), not sent to Ecofy.
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_ALL_ROLES } from "@/lib/ecofy/access";
import { epcPartnerInputSchema } from "@/lib/ecofy/actionSchemas";
import { ecofyActorName } from "@/lib/ecofy/queries";
import { createEpcPartner, ecofyCall, EcofyCallError, type EcofyEpcPartner } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";

function ecofyStatus(err: unknown): number {
    return err instanceof EcofyCallError ? (err.status >= 400 && err.status < 600 ? err.status : 502) : 500;
}

export const GET = withErrorHandler(async () => {
    await requireRole([...ECOFY_ALL_ROLES]);
    try {
        const data = await ecofyCall<EcofyEpcPartner[]>("GET", "/epc-partners", { query: { limit: 100 } });
        return successResponse(Array.isArray(data) ? data : []);
    } catch (err) {
        return errorResponse(err instanceof Error ? err.message : "Could not load EPC agents from Ecofy", ecofyStatus(err));
    }
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole([...ECOFY_ALL_ROLES]);
    const parsed = epcPartnerInputSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
        const first = parsed.error.issues[0];
        return errorResponse(`Invalid EPC agent${first ? `: ${first.path.join(".") || "input"} ${first.message}` : ""}`, 400);
    }
    try {
        return successResponse(await createEpcPartner(parsed.data, ecofyActorName(user)), 201);
    } catch (err) {
        return errorResponse(err instanceof Error ? err.message : "Ecofy could not add the EPC agent", ecofyStatus(err));
    }
});
