// POST /api/admin/upload/validate — BRD §0.4 Step 1/2. Parses the CSV,
// validates every row, and classifies duplicates against existing dealer_leads.
// Writes nothing — pure preview.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import {
    MAX_UPLOAD_ROWS,
    parseCsv,
    parseHeaders,
    validateUpload,
} from "@/lib/admin/csvUpload";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
    file_name: z.string().trim().min(1).max(255),
    csv_text: z.string().min(1).max(6_000_000),
});

export const POST = withErrorHandler(async (req: Request) => {
    await requireRole(["admin", "sales_head", "sales_insight", "inside_sales_rep"]);
    const b = BodySchema.parse(await req.json());

    const parsed = parseCsv(b.csv_text);
    if (parsed.length === 0) {
        return errorResponse("CSV has no data rows (need a header + rows).", 400);
    }
    if (parsed.length > MAX_UPLOAD_ROWS) {
        return errorResponse(
            `CSV has ${parsed.length} rows — the limit is ${MAX_UPLOAD_ROWS}.`,
            400,
        );
    }

    const result = await validateUpload(parsed, parseHeaders(b.csv_text));
    return successResponse(result);
});
