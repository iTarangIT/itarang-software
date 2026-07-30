import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { securityEvents } from "@/lib/db/schema";
import { requireSecurityAdmin } from "@/lib/security/route-guard";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ status: z.enum(["new", "reviewed", "ignored"]) });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSecurityAdmin();
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Invalid status" }, { status: 400 });

  const [row] = await db
    .update(securityEvents)
    .set({ status: parsed.data.status })
    .where(eq(securityEvents.id, id))
    .returning({ id: securityEvents.id, status: securityEvents.status });

  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true, id: row.id, status: row.status });
}
