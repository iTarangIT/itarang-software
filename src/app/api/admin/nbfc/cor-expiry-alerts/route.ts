/**
 * E-006 — RBI CoR expiry alert listing.
 *
 * GET /api/admin/nbfc/cor-expiry-alerts?windowDays=60
 *
 * Returns NBFCs whose cor_expiry_date falls within the next `windowDays`
 * (default 60, max 180). Each row carries the computed daysToExpiry. Used
 * by the admin dashboard and by the daily cron at /api/cron/nbfc-cor-expiry.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { and, gte, lte, isNotNull } from "drizzle-orm";
import { nbfc } from "@/lib/db/schema";
import { resolveAdminActor, statusFromError } from "@/lib/nbfc/admin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Query = z.object({
  windowDays: z.coerce.number().int().min(1).max(180).default(60),
});

function todayIsoDate(): string {
  // Anchor to UTC date so test fixtures and prod cron don't drift across TZs.
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso + "T00:00:00Z").getTime();
  const to = new Date(toIso + "T00:00:00Z").getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

export async function GET(req: NextRequest) {
  try {
    await resolveAdminActor(req.headers);

    const url = new URL(req.url);
    const parsed = Query.safeParse({
      windowDays: url.searchParams.get("windowDays") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: "UNPROCESSABLE: validation failed",
          issues: parsed.error.issues,
        },
        { status: 422 },
      );
    }

    const today = todayIsoDate();
    const windowEnd = addDaysIso(today, parsed.data.windowDays);

    const rows = await db
      .select({
        id: nbfc.id,
        short_name: nbfc.short_name,
        cor_expiry_date: nbfc.cor_expiry_date,
      })
      .from(nbfc)
      .where(
        and(
          isNotNull(nbfc.cor_expiry_date),
          gte(nbfc.cor_expiry_date, today),
          lte(nbfc.cor_expiry_date, windowEnd),
        ),
      );

    const items = rows.map((r) => {
      const raw: unknown = r.cor_expiry_date;
      const expiryIso =
        raw instanceof Date
          ? raw.toISOString().slice(0, 10)
          : String(raw);
      return {
        nbfcId: r.id,
        shortName: r.short_name,
        corExpiryDate: expiryIso,
        daysToExpiry: daysBetween(today, expiryIso),
      };
    });

    return NextResponse.json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
