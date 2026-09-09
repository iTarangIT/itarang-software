/**
 * E-292 — /api/admin/nbfc/refurbishers
 *
 *   GET   — the refurbisher partner directory (`?include_inactive=1` for all)
 *   POST  — onboard a refurbisher: the row, then their portal login. A bounced
 *           credentials email is a STATE (credential_dispatch_failed), not a
 *           failure — the partner exists and the directory offers a retry.
 *
 * Reading is open to the admin role set (the assign dropdown needs it);
 * writing is the same four roles that act on refurbishment lots.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError, validationError } from "@/lib/nbfc/http-error";
import { resolveAdminActor, statusFromError, ADMIN_ROLES } from "@/lib/nbfc/admin/auth";
import { createRefurbisher, listRefurbishers } from "@/lib/refurbisher/service";
import { issueRefurbisherCredentials } from "@/lib/refurbisher/credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACT_ROLES = new Set(["admin", "ceo", "business_head", "sales_head"]);

const Body = z
  .object({
    name: z.string().trim().min(2).max(160),
    contact_name: z.string().trim().max(120).nullable().optional(),
    email: z.string().trim().email().max(200),
    phone: z.string().trim().min(8).max(20).nullable().optional(),
    address: z.string().trim().max(1000).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    state: z.string().trim().max(120).nullable().optional(),
    gstin: z.string().trim().max(20).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    /** Skip the login for now (e.g. a partner iTarang acts for by hand). */
    issue_login: z.boolean().optional(),
  })
  .strict();

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveAdminActor(req.headers);
    if (!(ADMIN_ROLES as readonly string[]).includes(actor.role)) throw new Error("FORBIDDEN: not an admin");
    const include_inactive = new URL(req.url).searchParams.get("include_inactive") === "1";
    const items = await listRefurbishers({ include_inactive });
    return NextResponse.json({ ok: true, items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: statusFromError(msg) });
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveAdminActor(req.headers);
    if (!ACT_ROLES.has(actor.role)) throw new Error("FORBIDDEN: cannot onboard refurbishers");
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: validationError(parsed.error), issues: parsed.error.issues }, { status: 400 });
    }
    const { issue_login, ...fields } = parsed.data;
    const created = await createRefurbisher({ ...fields, created_by: /^[0-9a-f-]{36}$/i.test(actor.user_id) ? actor.user_id : null });
    let credential: Awaited<ReturnType<typeof issueRefurbisherCredentials>> | null = null;
    if (issue_login !== false) {
      credential = await issueRefurbisherCredentials(created.id, { loginUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin}/login` });
    }
    const items = await listRefurbishers({ include_inactive: true });
    return NextResponse.json({ ok: true, refurbisher: items.find((r) => r.id === created.id) ?? created, credential }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: statusFromError(msg) });
  }
}
