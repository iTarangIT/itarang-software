// GET /api/neodove/endpoints — which NeoDove endpoint env vars are actually set.
//
// The campaign form used to ask the operator to TYPE an env var name. That was
// wrong in both directions: it is pointless when only one endpoint exists, and
// a typo produces a campaign that looks configured but fails at push time with
// "endpoint not found" — the failure surfaces far from the mistake. The server
// already knows which names are populated, so it should say so.
//
// NAMES ONLY, NEVER VALUES. The URL is the sole credential NeoDove issues, so
// it must never leave the server. The name is not sensitive — it is already
// shown in the campaigns list and stored in the database — and knowing that
// NEODOVE_PUSH_ENDPOINT_TEST exists grants nothing without the value.

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { NEODOVE_ADMIN_ROLES } from "@/lib/neodove/roles";

export const runtime = "nodejs";
// process.env must be read per request, not baked in at build time: on the VPS
// the value can change with a PM2 restart and no rebuild.
export const dynamic = "force-dynamic";

// Matches the convention the config module documents: one env var per NeoDove
// campaign, named NEODOVE_<something>_ENDPOINT_<label>.
const ENDPOINT_NAME = /^NEODOVE_[A-Z0-9_]*ENDPOINT[A-Z0-9_]*$/;

export type NeodoveEndpointRef = {
    ref: string;
    /** update-only endpoints are the `?update=true` variant, not push targets. */
    kind: "push" | "update";
};

export const GET = withErrorHandler(async () => {
    await requireRole(NEODOVE_ADMIN_ROLES);

    const endpoints: NeodoveEndpointRef[] = Object.entries(process.env)
        // A declared-but-empty var is not configured. Treating it as available
        // would recreate exactly the failure this route exists to prevent.
        .filter(([name, value]) => ENDPOINT_NAME.test(name) && (value ?? "").trim() !== "")
        .map(([name]) => ({
            ref: name,
            kind: name.includes("UPDATE") ? ("update" as const) : ("push" as const),
        }))
        .sort((a, b) => a.ref.localeCompare(b.ref));

    return successResponse({ endpoints });
});
