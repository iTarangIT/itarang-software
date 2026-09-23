/**
 * Cron: the 08:00 Fleet Monitor card to Telegram.
 *
 * The BACKSTOP and the manual handle. The primary driver is the in-process
 * ticker in src/instrumentation-node.ts — vercel.json's crons do not fire on the
 * Hostinger PM2 boxes (docs/DEPLOY_RUNBOOK.md), so this route exists for a VPS
 * crontab line and for forcing a send by hand while testing.
 *
 * SAFE TO RUN ALONGSIDE THE TICKER. The send is claimed by a
 * (kind, digest_date, slot) row in digest_runs, so the two can only ever split
 * work, never duplicate it. `?force=1` skips the "is it 08:00 yet" check but is
 * STILL subject to the claim, so a second curl on the same IST day returns
 * `sent: false, reason: "already_claimed"` rather than posting twice.
 *
 * Auth: trusts the Vercel cron header, else a `Bearer CRON_SECRET`, else allows
 * unauthenticated outside production — matching its sibling crons.
 *
 * Crontab line for the VPS (the box runs UTC; 08:00 IST is 02:30 UTC):
 *
 *   30 2 * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     http://127.0.0.1:3002/api/cron/monitor-morning >> /var/log/itarang-cron.log 2>&1
 */
import { NextRequest, NextResponse } from "next/server";

import { runMonitorMorningReport } from "@/lib/monitor/morning-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorised(req: NextRequest): boolean {
    if (req.headers.get("x-vercel-cron")) return true;
    const auth = req.headers.get("authorization") ?? "";
    const expected = process.env.CRON_SECRET;
    if (expected && auth === `Bearer ${expected}`) return true;
    if (process.env.NODE_ENV !== "production") return true;
    return false;
}

async function handle(req: NextRequest) {
    if (!isAuthorised(req)) {
        return NextResponse.json({ success: false, error: { message: "Unauthorized" } }, { status: 401 });
    }

    const force = new URL(req.url).searchParams.get("force") === "1";
    const result = await runMonitorMorningReport({ triggeredBy: "cron", force });

    return NextResponse.json({ success: true, result });
}

export async function POST(req: NextRequest) {
    return handle(req);
}

/** GET as well, so a browser or uptime check can trigger it while testing. */
export async function GET(req: NextRequest) {
    return handle(req);
}
