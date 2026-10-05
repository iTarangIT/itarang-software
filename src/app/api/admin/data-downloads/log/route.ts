// GET /api/admin/data-downloads/log — who downloaded what, when, how many rows
// and whether the file carried full phone numbers (tracker ID 13). Admin and
// CEO only: these files carry phone numbers.

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { listDataDownloads } from "@/lib/exports/downloadLog";
import { DOWNLOAD_LOG_ROLES } from "@/lib/exports/datasets/types";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
    await requireRole([...DOWNLOAD_LOG_ROLES]);
    return successResponse({ downloads: await listDataDownloads(200) });
});
