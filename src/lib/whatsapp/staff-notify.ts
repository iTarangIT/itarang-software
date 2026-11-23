/**
 * WhatsApp to a staff login (NBFC user, iTarang admin, sales head …) — not to a
 * lead's customer/dealer thread. 23 Nov 2026 (Battery Pool notifications).
 *
 * Free text first (carries the full message; lands when the person's 24-hour
 * window is open), then the approved `lead_action` template as the fallback
 * that reaches a closed window. Never throws — returns ok/error so callers can
 * report delivery.
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

export type StaffSendResult = { ok: boolean; error: string | null };

/** Last 10 digits of an Indian mobile, or null when it is not one. */
export function normaliseIndianMobile(raw: string | null | undefined): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

export async function sendStaffWhatsApp(
  mobile: string | null | undefined,
  body: string,
  template: { customer: string; ref: string; what: string },
): Promise<StaffSendResult> {
  const ten = normaliseIndianMobile(mobile);
  if (!ten) return { ok: false, error: "no valid mobile number" };
  try {
    const { getAdapter } = await import("@/lib/whatsapp");
    const { logOutbound } = await import("@/lib/whatsapp/notifications");
    const { resolveTemplate } = await import("@/lib/whatsapp/templates");
    const { oneLine } = await import("@/lib/whatsapp/window");
    const to = `91${ten}`;
    const adapter = getAdapter();
    const tpl = resolveTemplate("lead_action");
    let res = await adapter.sendText(to, body);
    await logOutbound(null, res, { messageType: "text", textBody: body });
    if (!res.ok && tpl) {
      const params = [template.customer, template.ref, template.what].map((p) => oneLine(p, 900));
      res = await adapter.sendTemplate(to, tpl.name, tpl.lang, params);
      await logOutbound(null, res, { messageType: "template", textBody: params.join(" | "), templateName: tpl.name });
    }
    if (!res.ok) console.warn(`[staff-notify] WhatsApp to ••${ten.slice(-4)} not delivered: ${res.error ?? "unknown"}`);
    return { ok: res.ok, error: res.ok ? null : String(res.error ?? "not delivered") };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[staff-notify] WhatsApp failed", msg);
    return { ok: false, error: msg };
  }
}

/** WhatsApp a login by users.id (uses users.phone). Never throws. */
export async function whatsAppUser(
  userId: string,
  body: string,
  template: { customer: string; ref: string; what: string },
): Promise<StaffSendResult> {
  try {
    const [u] = await db
      .select({ phone: users.phone })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.is_active, true)))
      .limit(1);
    return await sendStaffWhatsApp(u?.phone ?? null, body, template);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
