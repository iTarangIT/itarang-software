import { NextRequest, NextResponse } from "next/server";
import { LEADS_PAGE_ROLES } from "@/lib/leads/access";
import { guardApi } from "@/lib/auth/apiGuard";
import { generateOverallSummary } from "@/lib/leads/overallSummary";
import { overallSummaryPrompt } from "@/lib/leads/overallSummaryRules";

export async function POST(req: NextRequest) {
  // ID 118: signed in, with a role that reaches this screen.
  const authGate = await guardApi([...LEADS_PAGE_ROLES]);
  if (!authGate.ok) return authGate.response;
  const { transcripts, dealerName, shopName, location } = await req.json();

  if (!transcripts) {
    return NextResponse.json({ summary: null });
  }

  // Same prompt and model the server uses when it writes the summary itself
  // (ID 118 option B, src/lib/leads/overallSummary.ts).
  const summary = await generateOverallSummary(
    overallSummaryPrompt({ transcripts, dealerName, shopName, location }),
  );

  return NextResponse.json({ summary });
}
