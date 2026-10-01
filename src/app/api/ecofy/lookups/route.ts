// E-307 — Ecofy dropdown contents (closure/return reasons, meeting and
// document types, EPC partners, financiers). GET ?what=a,b
import { requireRole } from "@/lib/auth-utils";
import { errorMessage, successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_ALL_ROLES } from "@/lib/ecofy/access";
import { ECOFY_LOOKUPS, type EcofyLookup } from "@/lib/ecofy/actionSchemas";
import { readLookup } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole([...ECOFY_ALL_ROLES]);
    const asked = (new URL(req.url).searchParams.get("what") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is EcofyLookup => (ECOFY_LOOKUPS as readonly string[]).includes(s));
    const parts = await Promise.all(
        [...new Set(asked)].map(async (what) => {
            try {
                return [what, { data: await readLookup(what) }] as const;
            } catch (err) {
                return [what, { error: errorMessage(err) }] as const;
            }
        }),
    );
    return successResponse(Object.fromEntries(parts));
});
