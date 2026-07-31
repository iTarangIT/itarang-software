import { NextResponse, after } from "next/server";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { securityEvents } from "@/lib/db/schema";
import { sendEmail } from "@/lib/email/mailer";
import { MetaWhatsAppAdapter } from "@/lib/whatsapp/meta";

export const dynamic = "force-dynamic";

// A single IP producing this many events in the window is a scan/flood → the
// event is escalated to critical.
const BURST_THRESHOLD = 10;
const BURST_WINDOW_MIN = 5;
// Don't email more than once per IP per this window (flood protection).
const ALERT_COOLDOWN_MIN = 15;

/**
 * Ingest for runtime security events. Called ONLY by the Edge middleware
 * (src/lib/security/report-event.ts) with the shared secret. Writes the event,
 * escalates on bursts, and fires a rate-limited alert on critical events.
 */
export async function POST(req: Request) {
  const secret = process.env.SECURITY_INTERNAL_SECRET;
  if (!secret) {
    // Feature not configured — refuse rather than accept unsigned events.
    return NextResponse.json({ ok: false, error: "detection not configured" }, { status: 503 });
  }
  if (req.headers.get("x-internal-secret") !== secret) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const ip = str(body.ip);
  const now = Date.now();

  // Burst escalation: many events from one IP in a short window.
  let severity = str(body.severity) || "low";
  let burstCount = 0;
  if (ip) {
    const cutoff = new Date(now - BURST_WINDOW_MIN * 60_000);
    const [row] = await db
      .select({ n: sql<number>`cast(count(*) as int)` })
      .from(securityEvents)
      .where(and(eq(securityEvents.ip, ip), gte(securityEvents.occurred_at, cutoff)));
    burstCount = row?.n ?? 0;
    if (burstCount >= BURST_THRESHOLD) severity = "critical";
  }

  const evidence = (body.evidence && typeof body.evidence === "object" ? body.evidence : {}) as Record<string, unknown>;
  if (burstCount >= BURST_THRESHOLD) evidence.burst = { count: burstCount, window_min: BURST_WINDOW_MIN };

  // Decide whether this event should alert, respecting the per-IP cooldown.
  let willAlert = false;
  if (severity === "critical" && ip) {
    const cooldown = new Date(now - ALERT_COOLDOWN_MIN * 60_000);
    const [recent] = await db
      .select({ id: securityEvents.id })
      .from(securityEvents)
      .where(and(eq(securityEvents.ip, ip), isNotNull(securityEvents.alerted_at), gte(securityEvents.alerted_at, cooldown)))
      .limit(1);
    willAlert = !recent;
  }

  const [inserted] = await db
    .insert(securityEvents)
    .values({
      event_type: str(body.event_type) || "sensitive_unauth",
      severity,
      action: str(body.action) === "blocked" ? "blocked" : "logged",
      ip,
      actor_user_id: str(body.actor_user_id),
      actor_role: str(body.actor_role),
      method: str(body.method)?.slice(0, 8),
      path: str(body.path) || "/",
      query: str(body.query)?.slice(0, 4000) ?? null,
      user_agent: str(body.user_agent)?.slice(0, 1000) ?? null,
      matched_rule: str(body.matched_rule),
      evidence,
      alerted_at: willAlert ? new Date() : null,
    })
    .returning({ id: securityEvents.id });

  if (willAlert && inserted) {
    // Send after the response so the ingest stays fast under a flood.
    after(async () => {
      try {
        await sendCriticalAlert({
          event_type: str(body.event_type) || "attack",
          matched_rule: str(body.matched_rule) || "",
          action: str(body.action) === "blocked" ? "blocked" : "logged",
          ip,
          path: str(body.path) || "/",
          method: str(body.method) || "",
          burstCount,
        });
      } catch (e) {
        console.error("[security] alert send failed:", e instanceof Error ? e.message : e);
      }
    });
  }

  return NextResponse.json({ ok: true, id: inserted?.id, severity, alerted: willAlert }, { status: 202 });
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length ? v : null;
}

async function sendCriticalAlert(e: {
  event_type: string;
  matched_rule: string;
  action: string;
  ip: string | null;
  path: string;
  method: string;
  burstCount: number;
}): Promise<void> {
  const to = process.env.SECURITY_ALERT_EMAIL || process.env.MAIL_FROM || "it@itarang.com";
  const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const subject = `[iTarang Security] Critical attack ${e.action === "blocked" ? "blocked" : "detected"} — ${e.event_type}`;
  const html = `
    <div style="font-family:system-ui,Arial,sans-serif;font-size:14px;color:#0f172a">
      <h2 style="color:#b91c1c;margin:0 0 8px">Critical security event ${e.action === "blocked" ? "(blocked)" : "(logged)"}</h2>
      <p style="margin:0 0 12px;color:#334155">A serious attack pattern was detected on the CRM at ${when} IST.</p>
      <table style="border-collapse:collapse;font-size:13px">
        <tr><td style="padding:3px 10px 3px 0;color:#64748b">Type</td><td><b>${e.event_type}</b> (${e.matched_rule})</td></tr>
        <tr><td style="padding:3px 10px 3px 0;color:#64748b">Action</td><td>${e.action}</td></tr>
        <tr><td style="padding:3px 10px 3px 0;color:#64748b">Source IP</td><td>${e.ip ?? "unknown"}</td></tr>
        <tr><td style="padding:3px 10px 3px 0;color:#64748b">Target</td><td>${e.method} ${e.path}</td></tr>
        ${e.burstCount >= BURST_THRESHOLD ? `<tr><td style="padding:3px 10px 3px 0;color:#64748b">Burst</td><td>${e.burstCount} events in ${BURST_WINDOW_MIN} min</td></tr>` : ""}
      </table>
      <p style="margin:14px 0 0;color:#334155">Review it on the <b>Live Attacks</b> tab at /it/security/live. Further alerts from this IP are muted for ${ALERT_COOLDOWN_MIN} minutes.</p>
    </div>`;

  // Email (independent of WhatsApp — one failing must not skip the other).
  try {
    await sendEmail({ to, subject, html });
  } catch (err) {
    console.error("[security] alert email failed:", err instanceof Error ? err.message : err);
  }

  // WhatsApp (opt-in via SECURITY_ALERT_WHATSAPP). Outside the 24h session
  // window Meta requires an APPROVED TEMPLATE — set SECURITY_ALERT_WHATSAPP_TEMPLATE
  // for reliable delivery; otherwise a plain text send only lands if the number
  // messaged the business recently.
  const wa = process.env.SECURITY_ALERT_WHATSAPP;
  if (wa) {
    try {
      const adapter = new MetaWhatsAppAdapter();
      const tmpl = process.env.SECURITY_ALERT_WHATSAPP_TEMPLATE;
      if (tmpl) {
        const lang = process.env.SECURITY_ALERT_WHATSAPP_TEMPLATE_LANG || "en";
        await adapter.sendTemplate(wa, tmpl, lang, [e.event_type, e.ip ?? "unknown", `${e.method} ${e.path}`]);
      } else {
        await adapter.sendText(
          wa,
          `iTarang Security: critical ${e.event_type} ${e.action === "blocked" ? "BLOCKED" : "detected"} from ${e.ip ?? "unknown"} on ${e.method} ${e.path} (${e.matched_rule}). See /it/security/live`,
        );
      }
    } catch (err) {
      console.error("[security] alert whatsapp failed:", err instanceof Error ? err.message : err);
    }
  }
}
