/**
 * POST /api/nbfc/audit-log/preview
 *
 * Returns a NON-PERSISTENT preview of the audit log row that *would* be
 * written if an admin confirms a borrower-impacting action. The shape mirrors
 * the exact field set the audit_logs writer uses, so the UI can show the
 * borrower-disclosure card BEFORE the action is committed.
 *
 * BRD reference: Section 6.4.2 — "Audit Log Entry Preview: Every
 * borrower-impacting action shows what will be logged before admin confirms:
 * 'Will log: timestamp | IMEI | action | reason | requested by | approver |
 * borrower notice record'."
 *
 * Auth (Phase C):
 *   - nbfc_partner: must be a member of the tenant they're previewing for
 *   - admin / ceo:  always allowed
 *   - dev (no session): allowed only when NBFC_DEMO_TENANT_SLUG is set and
 *                        NODE_ENV != production
 *
 * IMPORTANT: This route MUST NOT write to audit_logs. Preview-only.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getCurrentTenant, getSessionUser, requireNbfcAccess } from "@/lib/nbfc/tenant";
import {
  PreviewRequestSchema,
  composeWillLog,
  type SessionLike,
  type WillLog,
} from "./preview-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function lookupUserDisplayName(userId: string): Promise<string | null> {
  const rows = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!rows[0]) return null;
  return rows[0].name || rows[0].email || null;
}

export async function POST(req: Request) {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON body" },
        { status: 400 },
      );
    }

    const parsed = PreviewRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION_ERROR", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const tenant = await getCurrentTenant();
    await requireNbfcAccess(tenant.id);

    const session = await getSessionUser();
    const sessionLike: SessionLike | null = session
      ? { id: session.id, email: session.email }
      : null;

    const willLog: WillLog = await composeWillLog(parsed.data, {
      session: sessionLike,
      lookupUserDisplayName,
      lookupBorrowerNoticeChannel: async () => null, // table not yet in schema
    });

    // Explicitly do NOT insert into audit_logs. This is a read-only preview.
    return NextResponse.json({ ok: true, will_log: willLog });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("UNAUTHORIZED")
      ? 401
      : msg.startsWith("FORBIDDEN")
        ? 403
        : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
