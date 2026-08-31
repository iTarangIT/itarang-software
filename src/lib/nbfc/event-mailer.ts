/**
 * E-276 — NBFC event emails (contact-email layer).
 *
 * Sends a plain email for NBFC-facing events (file routed to the NBFC, docs
 * arriving in its dashboard, reject / correction-request confirmations, offer
 * accepted, loan disbursed) to the address the NBFC configured in
 * Settings → Notification Channels, CC'ing the platform monitoring inbox
 * (NBFC_GLOBAL_NOTIFY_EMAIL env var).
 *
 * This layer is ADDITIVE to the emit() hub — portal bell rows and seat-login
 * emails are unchanged. Always sent through the platform mailer, never the
 * tenant's own_smtp override (the NBFC is the recipient here, not the sender).
 *
 * To-address fallback chain:
 *   nbfc_notification_channels.notification_email
 *   → nbfc_tenants.contact_email
 *   → nbfc.primary_contact_email (by nbfc.tenant_id)
 * When none resolves (or tenantId is null), the monitoring inbox becomes the
 * To so it still sees every event. Never throws — callers fire-and-forget.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfc, nbfcNotificationChannels, nbfcTenants } from "@/lib/db/schema";
import { sendEmail } from "@/lib/email/mailer";

export function esc(v: unknown): string {
  const s = v == null ? "" : String(v);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface NbfcEventEmailInput {
  /** NBFC portal tenant (nbfc_tenants.id). null → monitoring inbox only. */
  tenantId: string | null;
  subject: string;
  /** One-line description of WHAT HAPPENED — always shown first, in bold. */
  eventLabel?: string | null;
  leadId?: string | null;
  customerName?: string | null;
  dealerName?: string | null;
  /** Names of the files involved in this update (uploaded / pushed / shared). */
  files?: Array<string | null | undefined> | null;
  /** Extra detail rows [label, value]; empty values are skipped. */
  extraRows?: Array<[string, string | number | null | undefined]>;
  /** Optional extra HTML appended after the details table; escape values with esc(). */
  bodyHtml?: string;
}

async function resolveNbfcEmail(tenantId: string): Promise<string | null> {
  const [channel] = await db
    .select({ email: nbfcNotificationChannels.notification_email })
    .from(nbfcNotificationChannels)
    .where(eq(nbfcNotificationChannels.tenant_id, tenantId))
    .limit(1);
  if (channel?.email?.trim()) return channel.email.trim();

  const [tenant] = await db
    .select({ email: nbfcTenants.contact_email })
    .from(nbfcTenants)
    .where(eq(nbfcTenants.id, tenantId))
    .limit(1);
  if (tenant?.email?.trim()) return tenant.email.trim();

  const [master] = await db
    .select({ email: nbfc.primary_contact_email })
    .from(nbfc)
    .where(eq(nbfc.tenant_id, tenantId))
    .limit(1);
  if (master?.email?.trim()) return master.email.trim();

  return null;
}

export async function sendNbfcEventEmail(p: NbfcEventEmailInput): Promise<void> {
  try {
    const globalEmail = process.env.NBFC_GLOBAL_NOTIFY_EMAIL?.trim() || null;
    const nbfcEmail = p.tenantId ? await resolveNbfcEmail(p.tenantId) : null;

    if (!nbfcEmail && !globalEmail) {
      console.warn(
        `[nbfc-event-mailer] no recipient for tenant=${p.tenantId ?? "-"} (no NBFC email, NBFC_GLOBAL_NOTIFY_EMAIL unset); skipping "${p.subject}"`,
      );
      return;
    }

    const to = nbfcEmail ?? globalEmail!;
    const cc = nbfcEmail && globalEmail && globalEmail !== nbfcEmail ? globalEmail : undefined;

    const rows: Array<[string, string]> = [];
    if (p.leadId) rows.push(["Lead ID", p.leadId]);
    if (p.customerName) rows.push(["Customer", p.customerName]);
    if (p.dealerName) rows.push(["Dealer", p.dealerName]);
    for (const [label, value] of p.extraRows ?? []) {
      if (value != null && String(value).trim() !== "") rows.push([label, String(value)]);
    }
    const fileNames = (p.files ?? []).filter((f): f is string => Boolean(f && f.trim()));

    const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b">
      ${p.eventLabel ? `<p style="font-size:15px"><b>${esc(p.eventLabel)}</b></p>` : ""}
      ${
        rows.length
          ? `<table style="border-collapse:collapse">${rows
              .map(
                ([label, value]) =>
                  `<tr><td style="padding:4px 12px 4px 0;color:#64748b;vertical-align:top">${esc(label)}</td><td>${esc(value)}</td></tr>`,
              )
              .join("")}</table>`
          : ""
      }
      ${
        fileNames.length
          ? `<p style="margin-bottom:4px;color:#64748b">File${fileNames.length === 1 ? "" : "s"} in this update:</p>
             <ul style="margin-top:0">${fileNames.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`
          : ""
      }
      ${p.bodyHtml ?? ""}
      <p style="color:#94a3b8;font-size:12px">This is an automated iTarang CRM notification${
        p.leadId ? ` for Lead ${esc(p.leadId)}` : ""
      }.</p>
    </div>`;

    await sendEmail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to,
      cc,
      subject: p.subject,
      html,
    });
  } catch (err) {
    console.warn(`[nbfc-event-mailer] failed to send "${p.subject}" (tenant=${p.tenantId ?? "-"})`, err);
  }
}
