// GET|POST /api/cron/dealer-agreement-refresh — backstop for the in-process
// dealer agreement refresh sweep (tracker ID 53). Asks Digio about every open,
// initiated dealer agreement and records any change. Auth: `Bearer CRON_SECRET`
// (or Vercel cron); closed when CRON_SECRET is unset (ID 130).

import { NextRequest, NextResponse } from "next/server";
import { runDealerAgreementRefreshSweep } from "@/lib/agreement/autoRefreshSweep";
import { isCronAuthorised } from "@/lib/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function run(req: NextRequest) {
  if (!isCronAuthorised(req)) {
    return NextResponse.json({ success: false, error: { message: "Unauthorised" } }, { status: 401 });
  }
  const result = await runDealerAgreementRefreshSweep();
  return NextResponse.json({ success: true, data: result });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
