import { NextResponse } from "next/server";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { securityEvents } from "@/lib/db/schema";
import { requireSecurityAdmin } from "@/lib/security/route-guard";

export const dynamic = "force-dynamic";

/** Count of NEW (unreviewed) attack events in the last 7 days — for the nav badge. */
export async function GET() {
  const auth = await requireSecurityAdmin();
  if (!auth.ok) return auth.response;

  const [row] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(securityEvents)
    .where(
      and(eq(securityEvents.status, "new"), gte(securityEvents.occurred_at, sql`now() - interval '7 days'`)),
    );

  return NextResponse.json({ count: row?.count ?? 0 });
}
