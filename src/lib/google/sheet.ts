import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

export const SHEETS = {
  CONVERTED: "itarang_leads",
  SALES_CALL: "Sales_Call",
};

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

const SALES_CALL_HEADERS = [
  "Lead ID",
  "Timestamp",
  "Direction",
  "To Number",
  "From Number",
  "Transcript",
  "Summary",
  "Conv ID",
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

async function writeHeaders(sheets: any, spreadsheetId: string, meta: any) {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEETS.CONVERTED}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  const sheetId = meta.data.sheets?.find(
    (s: any) => s.properties?.title === SHEETS.CONVERTED,
  )?.properties?.sheetId;

  if (sheetId !== undefined) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
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

  console.log("[SHEETS] Headers written to tab:", SHEETS.CONVERTED);
}

export async function ensureSheetHeaders() {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID!;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheets =
    meta.data.sheets?.map((s: any) => s.properties?.title) ?? [];

  const convertedExists = existingSheets.some(
    (name: string) => name?.toLowerCase() === SHEETS.CONVERTED.toLowerCase(),
  );

  if (!convertedExists) {
    // Tab doesn't exist — create it
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

    await writeHeaders(sheets, spreadsheetId, meta);
  } else {
    // Tab exists — check if header row is empty
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${SHEETS.CONVERTED}!A1:J1`,
    });

    const firstRow = existing.data.values?.[0];
    if (!firstRow || firstRow.length === 0) {
      await writeHeaders(sheets, spreadsheetId, meta);
    }
  }
}

async function ensureSalesCallHeaders(): Promise<string> {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID!;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheets =
    meta.data.sheets?.map((s: any) => s.properties?.title) ?? [];

  // Find the actual tab name (case-insensitive)
  let tabName = existingSheets.find(
    (name: string) => name?.toLowerCase() === SHEETS.SALES_CALL.toLowerCase(),
  );

  if (!tabName) {
    tabName = SHEETS.SALES_CALL;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: tabName,
                gridProperties: { frozenRowCount: 1 },
              },
            },
          },
        ],
      },
    });

    console.log("[SHEETS] Created tab:", tabName);
  }

  // Ensure headers exist
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A1:H1`,
  });

  const firstRow = existing.data.values?.[0];
  if (!firstRow || firstRow.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [SALES_CALL_HEADERS] },
    });
  }

  // Always fix styling — header row black, data rows white
  const sheetId = (await sheets.spreadsheets.get({ spreadsheetId }))
    .data.sheets?.find((s: any) => s.properties?.title === tabName)
    ?.properties?.sheetId;

  if (sheetId !== undefined) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            // Header: black background, white bold text
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: SALES_CALL_HEADERS.length,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0, green: 0, blue: 0 },
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
            // Data rows: white background, normal black text
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: SALES_CALL_HEADERS.length,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 1, green: 1, blue: 1 },
                  textFormat: {
                    bold: false,
                    foregroundColor: { red: 0, green: 0, blue: 0 },
                    fontSize: 10,
                  },
                },
              },
              fields:
                "userEnteredFormat(backgroundColor,textFormat)",
            },
          },
        ],
      },
    });
  }

  console.log("[SHEETS] Headers and styling ensured for tab:", tabName);

  return tabName;
}

export async function appendSalesCallLog(call: {
  leadId: string;
  timestamp: Date;
  direction: string;
  toNumber: string;
  fromNumber: string;
  transcript: string;
  summary: string;
  convId: string;
}) {
  try {
    const tabName = await ensureSalesCallHeaders();

    const sheets = await getSheetsClient();
    const spreadsheetId = process.env.GOOGLE_SHEET_ID!;

    const row = [
      call.leadId,
      call.timestamp.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
      call.direction,
      call.toNumber,
      call.fromNumber,
      call.transcript,
      call.summary,
      call.convId,
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tabName}!A:H`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    console.log(
      `[SHEETS] Appended sales call log: ${call.leadId} — ${call.convId}`,
    );
  } catch (err) {
    console.error("[SHEETS] Failed to append sales call log:", err);
  }
}

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
    console.error("[SHEETS] Failed to append lead:", err);
  }
}
