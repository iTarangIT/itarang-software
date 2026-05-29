/**
 * E-105 — Hourly cron: pull modified Zoho Invoice records into zoho_invoices.
 * Schedule: every hour at :05 (configured in vercel.json).
 *
 * Auth model (mirrors /api/cron/nbfc-cor-expiry):
 *   - Vercel cron header `x-vercel-cron` is trusted automatically.
 *   - Manual invocation accepts `authorization: Bearer <CRON_SECRET>`.
 *   - Non-production allows unauthenticated triggers for dev tooling.
 */
import { NextRequest, NextResponse } from "next/server";
import { syncInvoicesSinceLastRun } from "@/lib/zoho/sync";

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

async function runJob(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }

  try {
    const result = await syncInvoicesSinceLastRun();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cron/zoho-sync] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return runJob(req);
}

export async function POST(req: NextRequest) {
  return runJob(req);
}
