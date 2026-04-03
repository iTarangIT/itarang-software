import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

// Sheet tab names
export const SHEETS = {
  CONVERTED: "Converted Leads",
};

// Column headers — must match appendConvertedLead row order
const HEADERS = [
  "Lead ID",
  "Dealer Name",
  "Phone",
  "Email",
  "Website",
  "City",
  "Address",
  "Source",
  "Converted At",
  "Converted By",
];

function getAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
    key: process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    scopes: SCOPES,
  });
}

async function getSheetsClient() {
  const auth = getAuth();
  return google.sheets({ version: "v4", auth });
}

// ─── Ensure header row exists ─────────────────────────────────

export async function ensureSheetHeaders() {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID!;

  // Check if sheet tab exists, create if not
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheets =
    meta.data.sheets?.map((s) => s.properties?.title) ?? [];

  if (!existingSheets.includes(SHEETS.CONVERTED)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: SHEETS.CONVERTED,
                gridProperties: { frozenRowCount: 1 },
              },
            },
          },
        ],
      },
    });

    // Write headers
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEETS.CONVERTED}!A1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [HEADERS],
      },
    });

    // Style header row — bold + dark background
    const sheetId = meta.data.sheets?.find(
      (s) => s.properties?.title === SHEETS.CONVERTED,
    )?.properties?.sheetId;

    if (sheetId !== undefined) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              repeatCell: {
                range: {
                  sheetId,
                  startRowIndex: 0,
                  endRowIndex: 1,
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: { red: 0.1, green: 0.1, blue: 0.1 },
                    textFormat: {
                      bold: true,
                      foregroundColor: { red: 1, green: 1, blue: 1 },
                      fontSize: 11,
                    },
                    horizontalAlignment: "CENTER",
                  },
                },
                fields:
                  "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
              },
            },
            {
              updateSheetProperties: {
                properties: {
                  sheetId,
                  gridProperties: { frozenRowCount: 1 },
                },
                fields: "gridProperties.frozenRowCount",
              },
            },
          ],
        },
      });
    }

    console.log("[SHEETS] Created 'Converted Leads' tab with headers");
  }
}

// ─── Append a single converted lead ──────────────────────────

export async function appendConvertedLead(lead: {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  city: string | null;
  address: string | null;
  source: string | null;
  convertedAt: Date;
  convertedBy: string;
}) {
  try {
    await ensureSheetHeaders();

    const sheets = await getSheetsClient();
    const spreadsheetId = process.env.GOOGLE_SHEET_ID!;

    const row = [
      lead.id,
      lead.name ?? "—",
      lead.phone ?? "—",
      lead.email ?? "—",
      lead.website ?? "—",
      lead.city ?? "—",
      lead.address ?? "—",
      lead.source ?? "—",
      lead.convertedAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
      lead.convertedBy,
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${SHEETS.CONVERTED}!A:J`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    console.log(`[SHEETS] Appended converted lead: ${lead.id} — ${lead.name}`);
  } catch (err) {
    // Never throw — Google Sheets failure must not break the conversion flow
    console.error("[SHEETS] Failed to append lead:", err);
  }
}
