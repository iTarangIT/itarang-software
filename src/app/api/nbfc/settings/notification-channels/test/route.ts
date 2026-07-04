/**
 * POST /api/nbfc/settings/notification-channels/test — send a test message
 * through the tenant's resolved gateway (BRD Addendum V0.3.1 §15.5). Lets an
 * admin confirm their Email/SMS config works before relying on it. Requires the
 * `settings.notification_channels` permission.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";

import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { sendTestEmail, sendTestSms } from "@/lib/notifications/resolve-channel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  channel: z.enum(["email", "sms"]),
  to: z.string().min(3),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    if (!actor.can("settings.notification_channels")) {
      return NextResponse.json({ ok: false, error: "FORBIDDEN: settings.notification_channels required" }, { status: 403 });
    }
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "VALIDATION", issues: parsed.error.issues }, { status: 400 });
    }

    if (parsed.data.channel === "email") {
      const r = await sendTestEmail(actor.tenant_id, parsed.data.to);
      return NextResponse.json({ ok: true, via: r.via });
    }
    const r = await sendTestSms(actor.tenant_id, parsed.data.to);
    return NextResponse.json({ ok: r.success, error: r.error });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
