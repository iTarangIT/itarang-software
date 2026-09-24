/**
 * Cron: Green Energy News refresh (E-306).
 *
 * The BACKSTOP and the manual handle. The primary driver is the in-process
 * ticker in src/instrumentation-node.ts — vercel.json's crons do not fire on
 * the Hostinger PM2 boxes — so this exists for a VPS crontab line and for
 * forcing a run by hand while testing.
 *
 * SAFE TO RUN ALONGSIDE THE TICKER: without `?force=1` the run refuses to
 * start within 2 h of the last successful one; items are unique on URL and
 * the brief is unique per IST day, so even a forced run only adds new items.
 *
 * Auth: strict `Bearer CRON_SECRET` (src/lib/cron-auth.ts).
 *
 * Crontab line for the VPS (box runs UTC):
 *
 *   15 *\/3 * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     http://127.0.0.1:3002/api/cron/green-news >> /var/log/itarang-cron.log 2>&1
 */
import { NextRequest, NextResponse } from "next/server";

import { checkCronAuth } from "@/lib/cron-auth";
import { runGreenNewsRefresh } from "@/lib/news/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const force = new URL(req.url).searchParams.get("force") === "1";
  const result = await runGreenNewsRefresh({ triggeredBy: "cron", force });
  return NextResponse.json({ success: true, result });
}

export async function POST(req: NextRequest) {
  return handle(req);
}

/** GET as well, so a browser or uptime check can trigger it while testing. */
export async function GET(req: NextRequest) {
  return handle(req);
}
