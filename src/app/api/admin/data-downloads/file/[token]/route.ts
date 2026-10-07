// GET /api/admin/data-downloads/file/<token> — the link emailed for a file
// that was prepared in the background (tracker ID 13). Only the person who
// asked for the file, logged in, within 24 hours.

import { requireAuth } from "@/lib/auth-utils";
import { errorResponse, withErrorHandler } from "@/lib/api-utils";
import { readBackgroundFile } from "@/lib/exports/datasets/background";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

export const GET = withErrorHandler(async (_req: Request, context: Ctx) => {
    const user = await requireAuth();
    const file = await readBackgroundFile(user.id, (await context.params).token);
    if (!file) return errorResponse("This file has expired, or it was prepared for someone else.", 404);
    return new Response(new Uint8Array(file.body), {
        headers: {
            "Cache-Control": "private, no-store",
            "Content-Type": file.name.endsWith(".csv")
                ? "text/csv; charset=utf-8"
                : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${file.name}"`,
        },
    });
});
