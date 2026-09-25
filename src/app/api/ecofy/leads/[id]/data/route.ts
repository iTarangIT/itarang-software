// E-307 — live Ecofy data for one lead's detail tabs.
//   GET ?what=case,timeline,activities   (see ECOFY_LEAD_READS)
// Each part is fetched independently; a part that fails comes back as
// { error } so one refused tab never blanks the whole screen.
import { requireRole } from "@/lib/auth-utils";
import { errorMessage, successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_ALL_ROLES } from "@/lib/ecofy/access";
import { ECOFY_LEAD_READS, type EcofyLeadRead } from "@/lib/ecofy/actionSchemas";
import { getEcofyLeadForViewer } from "@/lib/ecofy/queries";
import { readLeadData } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole([...ECOFY_ALL_ROLES]);
    const { id } = await ctx.params;
    const lead = await getEcofyLeadForViewer(id, user);

    const asked = (new URL(req.url).searchParams.get("what") ?? "case")
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is EcofyLeadRead => (ECOFY_LEAD_READS as readonly string[]).includes(s));

    const parts = await Promise.all(
        [...new Set(asked)].map(async (what) => {
            try {
                return [what, { data: await readLeadData(lead.ecofy_case_id, what) }] as const;
            } catch (err) {
                return [what, { error: errorMessage(err) }] as const;
            }
        }),
    );
    return successResponse(Object.fromEntries(parts));
});
