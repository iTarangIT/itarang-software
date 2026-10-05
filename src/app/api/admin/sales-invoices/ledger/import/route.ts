/**
 * E-322 (tracker IDs 39, 71) — POST /api/admin/sales-invoices/ledger/import
 *
 * multipart/form-data:
 *   file  — the Vyapar sales register or GSTR-1 export (.xlsx / .xls / .csv)
 *   kind  — 'vyapar_register' | 'gstr1'
 *   mode  — 'preview' (default; nothing written) | 'commit'
 *
 * Preview first, always: the columns are matched by name because no sample
 * export existed when this was built, so the person importing confirms what
 * was read (columns found, unknown columns, every invoice) before committing.
 *
 * GET — the recent imports.
 */
import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";

import { db } from "@/lib/db";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { parseInvoiceWorkbook, type ImportKind } from "@/lib/sales/vyaparParse";
import { commitImport, previewImport } from "@/lib/sales/vyaparImport";
import { requireLedger } from "../_auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024;
const KINDS: ImportKind[] = ["vyapar_register", "gstr1"];

export const POST = withErrorHandler(async (req: NextRequest) => {
    const user = await requireLedger();
    const form = await req.formData();
    const file = form.get("file");
    const kind = String(form.get("kind") ?? "") as ImportKind;
    const mode = String(form.get("mode") ?? "preview");
    if (!(file instanceof File)) return errorResponse("No file uploaded", 400);
    if (!KINDS.includes(kind)) return errorResponse("Choose what the file is: Vyapar sales register or GSTR-1", 400);
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) return errorResponse("Upload an Excel (.xlsx / .xls) or CSV file", 400);
    if (file.size > MAX_BYTES) return errorResponse("File exceeds the 10 MB limit", 400);

    const parsed = parseInvoiceWorkbook(Buffer.from(await file.arrayBuffer()), kind);
    if (mode !== "commit") {
        return successResponse({ mode: "preview", file_name: file.name, preview: await previewImport(parsed) });
    }
    if (!parsed.documents.length) {
        return errorResponse(parsed.warnings[0] ?? "No invoices were read from the file — nothing imported.", 422);
    }
    const result = await commitImport(parsed, { fileName: file.name, actorId: user.id });
    return successResponse({ mode: "commit", file_name: file.name, ...result });
});

export const GET = withErrorHandler(async () => {
    await requireLedger();
    const rows = await db.execute(sql`
        SELECT i.id, i.kind, i.file_name, i.period_from, i.period_to, i.summary, i.created_at, u.name AS imported_by
          FROM invoice_imports i
          LEFT JOIN users u ON u.id = i.imported_by
         ORDER BY i.created_at DESC
         LIMIT 20
    `);
    return successResponse({ imports: rows });
});
