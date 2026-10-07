// GET /api/admin/data-downloads/log — who downloaded what, when, how many rows
// and whether the file carried full phone numbers (tracker ID 13). Admin and
// CEO see everyone's downloads; every other role that may download sees only
// its own (Reports › Data downloads "Recent downloads", 6 Oct 2026).

import { requireAuth } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { DATASETS, datasetAccess } from "@/lib/exports/datasets/registry";
import { listDataDownloads } from "@/lib/exports/downloadLog";
import { DOWNLOAD_LOG_ROLES } from "@/lib/exports/datasets/types";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
    const user = await requireAuth();
    const seesAll = (DOWNLOAD_LOG_ROLES as readonly string[]).includes(user.role);
    if (!seesAll && !DATASETS.some((d) => datasetAccess(d, (user.role ?? "").toLowerCase()))) {
        return errorResponse("Forbidden: Insufficient permissions", 403);
    }
    return successResponse({
        downloads: await listDataDownloads(seesAll ? 200 : 50, seesAll ? undefined : String(user.id)),
        everyone: seesAll,
    });
});
