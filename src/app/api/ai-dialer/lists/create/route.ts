// POST /api/ai-dialer/lists/create  (multipart/form-data: name, file)
//
// Creates a DRAFT dialer campaign from an uploaded Excel/CSV of leads. Parses
// the sheet deterministically (SheetJS / Papa — no LLM), imports the rows into
// dealer_leads (reusing existing leads by phone), and writes a campaign with
// status="draft" + region_filter={ kind:"list", ... } so the Lists tab can
// find it. The campaign holds its queue until the user presses Start, which
// hits /api/ai-dialer/lists/[id]/start.

import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { createCampaign } from "@/lib/queue/campaignTracker";
import { importListRows } from "@/lib/ai-dialer/listImport";
import Papa from "papaparse";
import * as XLSX from "xlsx";

const MAX_BYTES = 5 * 1024 * 1024;

export const POST = withErrorHandler(async (req: Request) => {
  // Resolve the creator, tolerating system/dev contexts with no session
  // (same posture as /api/ai-dialer/start).
  let triggeredBy: string | null = null;
  try {
    const user = await requireAuth();
    triggeredBy = (user as { id?: string } | null)?.id ?? null;
  } catch {
    triggeredBy = null;
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const name = String(formData.get("name") ?? "").trim();

  if (!name) return errorResponse("Campaign name is required", 400);
  if (!file) return errorResponse("No file uploaded", 400);

  const fileName = file.name.toLowerCase();
  if (
    !fileName.endsWith(".csv") &&
    !fileName.endsWith(".xlsx") &&
    !fileName.endsWith(".xls")
  ) {
    return errorResponse("Please upload a CSV or Excel (.xlsx) file", 400);
  }
  if (file.size > MAX_BYTES) {
    return errorResponse("File exceeds the 5 MB limit. Please split the file.", 400);
  }

  // Parse → array of row objects keyed by header. xlsx reads .csv too, but we
  // keep Papa for csv to match the inventory-upload pattern exactly.
  const buffer = await file.arrayBuffer();
  let rawRows: Record<string, unknown>[] = [];
  if (fileName.endsWith(".csv")) {
    const text = new TextDecoder().decode(buffer);
    const parsed = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: true,
    });
    rawRows = parsed.data ?? [];
  } else {
    const wb = XLSX.read(buffer, { cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return errorResponse("The file has no sheets", 400);
    rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      raw: false,
      defval: "",
    });
  }

  if (rawRows.length === 0) {
    return errorResponse("The file has no data rows", 400);
  }

  const summary = await importListRows(rawRows, { listName: name });

  if (summary.queueIds.length === 0) {
    return errorResponse(
      "No dialable phone numbers found. Make sure there's a phone column with valid 10-digit Indian mobile numbers.",
      400,
    );
  }

  const campaignId = await createCampaign({
    queueIds: summary.queueIds,
    // Placeholder — the real provider is chosen when the user presses Start.
    provider: "bolna",
    category: null,
    region: {
      kind: "list",
      listName: name,
      fileName: file.name,
      summary: {
        total: summary.total,
        imported: summary.imported,
        reused: summary.reused,
        invalid: summary.invalid,
      },
    },
    triggeredBy,
    status: "draft",
    name,
  });

  if (!campaignId) {
    return errorResponse("Failed to create the campaign. Please try again.", 500);
  }

  return successResponse({
    campaignId,
    name,
    total: summary.total,
    imported: summary.imported,
    reused: summary.reused,
    invalid: summary.invalid,
    queued: summary.queueIds.length,
  });
});
