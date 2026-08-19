// POST /api/bot/campaigns/upload  (multipart/form-data: name, file)
//
// Discord-bot entry point for the Excel → campaign flow. Parses an uploaded
// CSV/XLSX of leads, imports the rows into dealer_leads (reusing existing leads
// by phone), and creates a DRAFT dialer campaign owned by the Discord Bot
// service user. The campaign holds its queue until the bot calls
// POST /api/bot/campaigns/[id]/start.
//
// This mirrors /api/ai-dialer/lists/create but (a) is gated by BOT_API_KEY
// instead of a Supabase session, and (b) attributes the campaign to the bot
// service user so it's clearly identifiable in CRM history. region_filter keeps
// kind:"list" so bot campaigns also surface in the dashboard Lists tab.

import { successResponse, errorResponse } from "@/lib/api-utils";
import { withBotAuth } from "@/lib/bot/auth";
import { DISCORD_BOT_USER_ID, BOT_CAMPAIGN_SOURCE } from "@/lib/bot/constants";
import { createCampaign } from "@/lib/queue/campaignTracker";
import { importListRows } from "@/lib/ai-dialer/listImport";
import Papa from "papaparse";
import * as XLSX from "xlsx";

const MAX_BYTES = 5 * 1024 * 1024;

export const POST = withBotAuth(async (req: Request) => {
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

  // Parse → array of row objects keyed by header (deterministic, no LLM).
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

  const { campaignId, queued, blockedAiConnected } = await createCampaign({
    queueIds: summary.queueIds,
    // Placeholder — the real provider is locked in when /start is called
    // (defaults to elevenlabs for bot campaigns).
    provider: "elevenlabs",
    category: null,
    region: {
      kind: "list",
      source: BOT_CAMPAIGN_SOURCE,
      listName: name,
      fileName: file.name,
      summary: {
        total: summary.total,
        imported: summary.imported,
        reused: summary.reused,
        updated: summary.updated,
        invalid: summary.invalid,
      },
    },
    triggeredBy: DISCORD_BOT_USER_ID,
    status: "draft",
    name,
  });

  if (!campaignId && blockedAiConnected.length > 0) {
    return errorResponse(
      `All ${blockedAiConnected.length} dealers in this list have already been contacted by the AI. They need manual follow-up.`,
      409,
    );
  }

  if (!campaignId) {
    return errorResponse("Failed to create the campaign. Please try again.", 500);
  }

  return successResponse({
    campaignId,
    name,
    status: "draft",
    total: summary.total,
    imported: summary.imported,
    reused: summary.reused,
    updated: summary.updated,
    invalid: summary.invalid,
    queued,
    blockedAiConnected: blockedAiConnected.length,
  });
});
