// One-off verification for the Call_Review Google Sheet feature.
//
// Writes a single SAMPLE row so you can confirm the tab is created with the
// right headers, formatting, and reviewer columns — without waiting for a live
// dialer call. The row is clearly marked TEST; delete it from the sheet after.
//
// Run:
//   node --import tsx --env-file=.env.local scripts/test-call-review-sheet.ts
//
// Requires GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
// in .env.local (the same vars the dialer's sheet logging already uses).

import { appendCallReview } from "@/lib/google/sheet";

async function main() {
  if (!process.env.GOOGLE_SHEET_ID) {
    throw new Error("GOOGLE_SHEET_ID is not set — check .env.local");
  }

  console.log(
    `[test] Writing a sample row to sheet ${process.env.GOOGLE_SHEET_ID} …`,
  );

  // A connected call (has recording + transcript)
  await appendCallReview({
    uuid: "TEST-connected-call",
    campaign: "TEST — sample campaign",
    companyName: "TEST — Sharma Motors",
    dealerName: "TEST — Ramesh",
    recordingUrl: "https://example.com/recording/sample.mp3",
    transcript:
      "assistant: नमस्ते\nuser: Hello\nassistant: This is a sample transcript row for verifying the Call_Review sheet. Delete this row.",
  });

  // A no-conversation call (no_answer / busy / failed) — recording + transcript
  // are empty; the Transcript cell carries a short status note instead.
  await appendCallReview({
    uuid: "TEST-no-answer-call",
    campaign: "TEST — sample campaign",
    companyName: "TEST — Astha Enterprises",
    dealerName: "TEST — Suresh",
    recordingUrl: "",
    transcript: "No conversation (no_answer)",
  });

  console.log(
    "[test] Done. Open the spreadsheet and look for the 'Call_Review' tab.\n" +
      "       Delete the TEST row when you're satisfied with the layout.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[test] Failed:", err);
    process.exit(1);
  });
