// GET|POST /api/cron/dealer-agreement-refresh — backstop for the in-process
// dealer agreement refresh sweep (tracker ID 53). Asks Digio about every open,
// initiated dealer agreement and records any change. Auth: `Bearer CRON_SECRET`
// (or Vercel cron); open in non-production.

import { NextRequest, NextResponse } from "next/server";
import { runDealerAgreementRefreshSweep } from "@/lib/agreement/autoRefreshSweep";
import { fromVercelCron } from "@/lib/security/cronAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorised(req: NextRequest): boolean {
  if (fromVercelCron(req)) return true;
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && auth === `Bearer ${expected}`) return true;
  if (process.env.NODE_ENV !== "production") return true;
  return false;
}

async function run(req: NextRequest) {
  if (!isAuthorised(req)) {
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
