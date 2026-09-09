/**
 * E-292 — /api/admin/nbfc/refurbishers/[id]
 *
 *   PATCH — edit the partner (name, contact, address, GSTIN, notes, is_active).
 *           Deactivating also deactivates their login.
 *   POST  — `{ action: "resend-credentials" }` re-issues the portal password
 *           (the recovery path for a bounced credentials email). Refused while
 *           a login is already dispatched and working — deactivate first.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError, validationError } from "@/lib/nbfc/http-error";
import { resolveAdminActor, statusFromError } from "@/lib/nbfc/admin/auth";
import { getRefurbisher, updateRefurbisher } from "@/lib/refurbisher/service";
import { issueRefurbisherCredentials } from "@/lib/refurbisher/credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACT_ROLES = new Set(["admin", "ceo", "business_head", "sales_head"]);

const Patch = z
  .object({
    name: z.string().trim().min(2).max(160).optional(),
    contact_name: z.string().trim().max(120).nullable().optional(),
    email: z.string().trim().email().max(200).optional(),
    phone: z.string().trim().max(20).nullable().optional(),
    address: z.string().trim().max(1000).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    state: z.string().trim().max(120).nullable().optional(),
    gstin: z.string().trim().max(20).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .strict();

const Action = z.object({ action: z.enum(["resend-credentials"]), force: z.boolean().optional() }).strict();

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveAdminActor(req.headers);
    if (!ACT_ROLES.has(actor.role)) throw new Error("FORBIDDEN: cannot edit refurbishers");
    const { id } = await ctx.params;
    const parsed = Patch.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: validationError(parsed.error), issues: parsed.error.issues }, { status: 400 });
    }
    const refurbisher = await updateRefurbisher(id, parsed.data);
    return NextResponse.json({ ok: true, refurbisher });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: statusFromError(msg) });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveAdminActor(req.headers);
    if (!ACT_ROLES.has(actor.role)) throw new Error("FORBIDDEN: cannot issue refurbisher logins");
    const { id } = await ctx.params;
    const parsed = Action.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: validationError(parsed.error), issues: parsed.error.issues }, { status: 400 });
    }
    const ref = await getRefurbisher(id);
    if (!ref) return NextResponse.json({ ok: false, error: "NOT_FOUND: refurbisher not found" }, { status: 404 });
    if (!ref.is_active) throw new Error("CONFLICT: this refurbisher is deactivated — reactivate before issuing a login");
    if (ref.credential_dispatch_status === "dispatched" && ref.has_login && !parsed.data.force) {
      throw new Error("CONFLICT: this refurbisher already has a working login — re-sending would reset their password. Pass force to do it anyway.");
    }
    const credential = await issueRefurbisherCredentials(id, { loginUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin}/login` });
    return NextResponse.json({ ok: true, refurbisher: await getRefurbisher(id), credential });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: statusFromError(msg) });
  }
}
