// E-307 — a short-lived download URL for an Ecofy document.
//   GET ?leadId=<crm lead id>
// The lead id is required so the viewer's access is checked the same way as
// everywhere else; the document must belong to that lead's case.
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_ALL_ROLES } from "@/lib/ecofy/access";
import { getEcofyLeadForViewer } from "@/lib/ecofy/queries";
import { documentDownloadUrl, readLeadData } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";

class NotOnLead extends Error {
    readonly status = 404;
}

export const GET = withErrorHandler(async (req: Request, ctx: { params: Promise<{ documentId: string }> }) => {
    const user = await requireRole([...ECOFY_ALL_ROLES]);
    const { documentId } = await ctx.params;
    const leadId = new URL(req.url).searchParams.get("leadId") ?? "";
    const lead = await getEcofyLeadForViewer(leadId, user);

    // Quote PDFs are documents too, but the documents list is the one Ecofy
    // scopes to the case, so check both.
    const [docs, quotes] = await Promise.all([
        readLeadData(lead.ecofy_case_id, "documents").catch(() => []),
        readLeadData(lead.ecofy_case_id, "quotes").catch(() => []),
    ]);
    const ids = new Set<string>([
        ...((docs as Array<{ id: string }>) ?? []).map((d) => d.id),
        ...((quotes as Array<{ documentId: string }>) ?? []).map((q) => q.documentId),
    ]);
    if (!ids.has(documentId)) throw new NotOnLead("Document not found on this lead");

    return successResponse(await documentDownloadUrl(documentId));
});
