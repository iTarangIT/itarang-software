import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

export const SHEETS = {
  CONVERTED: "itarang_leads",
  SALES_CALL: "Sales_Call",
  CALL_REVIEW: "Campaign_Call_Review",
};

// Reviewers who leave feedback on each call. Each name becomes its own column
// on the Call_Review tab; edit this list to change who reviews.
export const CALL_REVIEWERS = [
  "Sonu",
  "Kartik",
  "Sanchit",
  "Abhishek",
  "Apoorv",
  "Nidhi",
  "Sweeti",
];

// Fixed call-data columns followed by one empty feedback column per reviewer.
const CALL_REVIEW_HEADERS = [
  "UUID",
  "Campaign",
  "Company Name",
  "Dealer Name",
  "Call Recording",
  "Transcript",
  ...CALL_REVIEWERS,
];

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

// 1-based column number → A1 column letter(s). 13 → "M".
function colLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
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

// Ensure the Campaign_Call_Review tab exists with headers, a frozen header row,
// header colors, and column widths. Header/structural styling is applied on
// creation (or if the header row was missing). Per-row data styling is handled
// by appendCallReview after each append. Returns the tab name and numeric id.
async function ensureCallReviewSheet(): Promise<{
  tabName: string;
  sheetId: number | null;
}> {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID!;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheets =
    meta.data.sheets?.map((s) => s.properties?.title) ?? [];

  // Find the actual tab name (case-insensitive)
  let tabName = existingSheets.find(
    (name) => name?.toLowerCase() === SHEETS.CALL_REVIEW.toLowerCase(),
  );

  const isNewTab = !tabName;

  if (!tabName) {
    tabName = SHEETS.CALL_REVIEW;
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
  const lastCol = colLetter(CALL_REVIEW_HEADERS.length);
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A1:${lastCol}1`,
  });

  const firstRow = existing.data.values?.[0];
  const headersMissing = !firstRow || firstRow.length === 0;
  if (headersMissing) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [CALL_REVIEW_HEADERS] },
    });
  }

  // Resolve the numeric sheet id (needed for all cell formatting).
  const sheetId =
    (await sheets.spreadsheets.get({ spreadsheetId })).data.sheets?.find(
      (s) => s.properties?.title === tabName,
    )?.properties?.sheetId ?? null;

  // Header/structural styling — only on creation or if headers were (re)written.
  if (sheetId != null && (isNewTab || headersMissing)) {
    const reviewerStart = CALL_REVIEW_HEADERS.length - CALL_REVIEWERS.length; // 6

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          // Freeze the header row
          {
            updateSheetProperties: {
              properties: {
                sheetId,
                gridProperties: { frozenRowCount: 1 },
              },
              fields: "gridProperties.frozenRowCount",
            },
          },
          // Call-data headers (UUID..Transcript): black bg, white bold, centered
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: reviewerStart,
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
                  verticalAlignment: "MIDDLE",
                },
              },
              fields:
                "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)",
            },
          },
          // Reviewer headers: distinct dark-teal accent so feedback area stands out
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: reviewerStart,
                endColumnIndex: CALL_REVIEW_HEADERS.length,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.04, green: 0.4, blue: 0.36 },
                  textFormat: {
                    bold: true,
                    foregroundColor: { red: 1, green: 1, blue: 1 },
                    fontSize: 11,
                  },
                  horizontalAlignment: "CENTER",
                  verticalAlignment: "MIDDLE",
                },
              },
              fields:
                "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)",
            },
          },
          // Column widths
          colWidth(sheetId, 0, 1, 180), // UUID
          colWidth(sheetId, 1, 2, 200), // Campaign
          colWidth(sheetId, 2, 4, 180), // Company + Dealer
          colWidth(sheetId, 4, 5, 260), // Recording
          colWidth(sheetId, 5, 6, 600), // Transcript
          colWidth(sheetId, reviewerStart, CALL_REVIEW_HEADERS.length, 160), // reviewers
        ],
      },
    });
  }

  return { tabName, sheetId };
}

// updateDimensionProperties request to set a fixed pixel width for a column range.
function colWidth(
  sheetId: number,
  startIndex: number,
  endIndex: number,
  pixelSize: number,
) {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension: "COLUMNS", startIndex, endIndex },
      properties: { pixelSize },
      fields: "pixelSize",
    },
  };
}

// Append one call to the Campaign_Call_Review tab. Fired per connected call
// from the post-call pipeline. Reviewer feedback columns are left blank for
// reviewers to fill in. Swallows all errors so a Sheets outage never breaks
// call finalization or campaign advancement.
export async function appendCallReview(review: {
  uuid: string;
  campaign: string;
  companyName: string;
  dealerName: string;
  recordingUrl: string;
  transcript: string;
}) {
  try {
    const { tabName, sheetId } = await ensureCallReviewSheet();

    const sheets = await getSheetsClient();
    const spreadsheetId = process.env.GOOGLE_SHEET_ID!;

    const row = [
      review.uuid,
      review.campaign,
      review.companyName,
      review.dealerName,
      review.recordingUrl,
      review.transcript,
      // one empty feedback cell per reviewer
      ...CALL_REVIEWERS.map(() => ""),
    ];

    const lastCol = colLetter(CALL_REVIEW_HEADERS.length);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tabName}!A:${lastCol}`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    // Re-assert plain data-row styling across every row below the header:
    // white background, normal black text, top-aligned, with the long Recording
    // + Transcript columns wrapped. This runs AFTER the append because
    // values.append copies the black header format onto the newly inserted row;
    // this overrides it so data rows match the clean Sales_Call look.
    if (sheetId != null) {
      const RECORDING_COL = 4;
      const TRANSCRIPT_COL = 5;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              repeatCell: {
                range: {
                  sheetId,
                  startRowIndex: 1,
                  startColumnIndex: 0,
                  endColumnIndex: CALL_REVIEW_HEADERS.length,
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: { red: 1, green: 1, blue: 1 },
                    textFormat: {
                      bold: false,
                      foregroundColor: { red: 0, green: 0, blue: 0 },
                      fontSize: 10,
                    },
                    verticalAlignment: "TOP",
                  },
                },
                fields:
                  "userEnteredFormat(backgroundColor,textFormat,verticalAlignment)",
              },
            },
            // Wrap the long Recording + Transcript columns
            {
              repeatCell: {
                range: {
                  sheetId,
                  startRowIndex: 1,
                  startColumnIndex: RECORDING_COL,
                  endColumnIndex: TRANSCRIPT_COL + 1,
                },
                cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
                fields: "userEnteredFormat(wrapStrategy)",
              },
            },
          ],
        },
      });
    }

    console.log(`[SHEETS] Appended call review: ${review.uuid}`);
  } catch (err) {
    console.error("[SHEETS] Failed to append call review:", err);
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
