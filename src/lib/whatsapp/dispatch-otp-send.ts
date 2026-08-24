/**
 * E-264 — deliver a dispatch OTP over WhatsApp.
 *
 * Kept in its own tiny module, imported dynamically by
 * src/lib/leads/dispatch-otp.ts, so the OTP service does not pull the WhatsApp
 * adapter into every route that sends a code.
 *
 * OTPs deliberately BYPASS the parked-prompt machinery in ./outbound. A code
 * that lives ten minutes is worthless behind a "we'll deliver this when you next
 * message us" queue — if the window is shut the caller needs to know now, so it
 * can fall through to a voice call instead.
 */

import { getAdapter } from "./index";
import { toWaPhone } from "./lead-push";
import { logOutbound } from "./notifications";
import { resolveTemplate } from "./templates";
import { inServiceWindow, oneLine } from "./window";

/**
 * Returns true only if Meta accepted the message.
 *
 * Inside the 24-hour window a plain text message is enough. Outside it, only an
 * approved template can be delivered — and if none is registered we return false
 * rather than firing a send Meta will reject, so the ladder moves on to a
 * channel that actually works.
 */
export async function sendDispatchOtpWhatsApp(
  phone: string,
  otp: string,
): Promise<boolean> {
  const waPhone = toWaPhone(phone);
  if (!waPhone) return false;

  const adapter = getAdapter();

  // Is there a live chat we are inside the window on?
  let sessionId: string | null = null;
  let windowOpen = false;
  try {
    const session = await findSessionByPhone(waPhone);
    if (session) {
      sessionId = session.id;
      windowOpen = inServiceWindow(session);
    }
  } catch {
    // No session lookup is fatal — we can still try a template.
  }

  if (windowOpen) {
    const res = await adapter.sendText(
      waPhone,
      `🔐 *${otp}* is your iTarang delivery confirmation code.\n\n` +
        `It is valid for 10 minutes. Please share it only with the person handing over your battery.`,
    );
    await logOutbound(sessionId, res, {
      messageType: "text",
      // Never log the code itself — whatsapp_messages is read by admin tooling.
      textBody: "[dispatch OTP sent]",
    });
    return res.ok;
  }

  const tpl = resolveTemplate("dispatch_otp");
  if (!tpl) return false;

  const res = await adapter.sendTemplate(waPhone, tpl.name, tpl.lang, [
    oneLine(otp),
  ]);
  await logOutbound(sessionId, res, {
    messageType: "template",
    textBody: "[dispatch OTP sent]",
    templateName: tpl.name,
  });
  return res.ok;
}

/** Thin wrapper so the lookup helper's lead-centric signature isn't forced here. */
async function findSessionByPhone(waPhone: string) {
  const { db } = await import("@/lib/db/index");
  const { whatsappOnboardingSessions } = await import("@/lib/db/schema");
  const { and, desc, eq, ne } = await import("drizzle-orm");
  const [row] = await db
    .select()
    .from(whatsappOnboardingSessions)
    .where(
      and(
        eq(whatsappOnboardingSessions.wa_phone, waPhone),
        ne(whatsappOnboardingSessions.session_kind, "operator_file"),
      ),
    )
    .orderBy(desc(whatsappOnboardingSessions.last_inbound_at))
    .limit(1);
  return row ?? null;
}
