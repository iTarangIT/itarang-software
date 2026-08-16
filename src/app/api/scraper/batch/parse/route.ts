import {
  withErrorHandler,
  successResponse,
  errorResponse,
} from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import {
  MAX_UPLOAD_BYTES,
  MAX_ROWS,
  parseBatchCsv,
} from "@/lib/scraper/batchImport";
import { jobCap } from "@/lib/scraper/commandParser";

// E-241 — POST /api/scraper/batch/parse
//
// Validates an uploaded spreadsheet and returns a per-row preview. Writes
// NOTHING. The operator sees exactly which rows are good and what is wrong with
// the rest, fixes their file, and only then submits to POST /api/scraper/batch
// — which re-validates from scratch, because this response is a courtesy and
// not a token of approval.
//
// Accepts CSV text. The client converts .xlsx/.xls with a lazy
// `await import("xlsx")` before posting, so SheetJS never enters the main
// bundle and the server never has to parse a binary workbook.

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const POST = withErrorHandler(async (req: Request) => {
  await requireRole(["sales_head", "ceo", "business_head"]);

  const form = await req.formData();
  const file = form.get("file");
  const expandWithAi = form.get("expand_with_ai") === "true";

  if (!file || typeof file === "string") {
    return errorResponse("No file uploaded (expected multipart field 'file').", 400);
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return errorResponse(
      `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${
        MAX_UPLOAD_BYTES / 1024 / 1024
      } MB.`,
      400,
    );
  }

  const text = await file.text();
  if (!text.trim()) {
    return errorResponse("File is empty.", 400);
  }

  const result = parseBatchCsv(text);

  // The parser reports its own file-level problems (no query column, too many
  // distinct queries) rather than throwing, so they arrive here as a message
  // the preview panel can print above the table.
  const cap = jobCap(expandWithAi);

  return successResponse({
    ...result,
    // Echoed so the preview and the submit button agree about the ceiling
    // without the client hard-coding it in a second place.
    limits: { max_rows: MAX_ROWS, max_jobs: cap },
    over_cap: result.validCount > cap,
  });
});
