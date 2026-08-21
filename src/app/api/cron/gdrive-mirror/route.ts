/**
 * Google Drive mirror sweep — the external-cron mirror of the in-process
 * ticker (E-255).
 *
 * Processes due `storage_drive_mirror` rows (uploads to Drive). Add
 * `?backfill=1` to first list the S3 bucket and enqueue every object that has
 * no ledger row yet — that is what backs up the corpus that pre-dates the
 * feature, and what catches the few uploads that bypass the app server.
 *
 * The 60 s ticker in `src/instrumentation-node.ts` is the primary path on the
 * pm2/Hostinger boxes; this route exists for Vercel, for the VPS crontab and
 * for poking the sweep by hand. Running both at once is safe: rows are claimed
 * with FOR UPDATE SKIP LOCKED, so two sweeps split the work.
 */

import { NextResponse } from "next/server";

import { checkCronAuth } from "@/lib/cron-auth";
import { runDriveMirrorBackfill, runDriveMirrorTick } from "@/lib/storage/drive-mirror";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
    if (process.env.NODE_ENV === "production") {
        const unauth = checkCronAuth(req);
        if (unauth) return unauth;
    }

    const url = new URL(req.url);
    const backfill = url.searchParams.get("backfill") === "1";
    const max = Number(url.searchParams.get("max") || "") || 25;

    try {
        const backfillResult = backfill ? await runDriveMirrorBackfill() : null;
        const tick = await runDriveMirrorTick({ max, timeBudgetMs: 45_000 });
        return NextResponse.json({ success: true, data: { backfill: backfillResult, tick } });
    } catch (error) {
        console.error("[cron:gdrive-mirror] failed:", error);
        const message = error instanceof Error ? error.message : "Sweep failed";
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}

export async function GET(req: Request) {
    return handle(req);
}

export async function POST(req: Request) {
    return handle(req);
}
