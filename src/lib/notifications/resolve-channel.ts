/**
 * Per-NBFC notification channel resolver — BRD Addendum V0.3.1 §15.5.
 *
 * THE NON-BREAKING SEAM. A send path that knows its tenant can resolve the
 * NBFC's own gateway here; with no tenant, no config row, or a channel left on
 * its '*_default' mode, the resolver returns the platform-global env gateway —
 * i.e. exactly what every existing send already uses. So wiring this in is
 * purely additive: untouched call sites keep using the global gateway.
 *
 * v1 stores gateway secrets as-is (encryption is a backlog item). Vendor names
 * stay out of NBFC-facing copy (§3.2); this module is server-only plumbing.
 */
import nodemailer from "nodemailer";

import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { nbfcNotificationChannels } from "@/lib/db/schema";
import { sendKycSms } from "@/lib/sms";
import type { SendSmsResult } from "@/lib/sms-types";
import { getMailer, type Mailer } from "@/lib/email/mailer";

export interface ResolvedEmail {
  transporter: Mailer;
  from: string;
  source: "tenant" | "global";
}

/** Wrap a raw nodemailer transporter in the shared Mailer shape. */
function wrapNodemailer(transporter: nodemailer.Transporter): Mailer {
  return {
    async sendMail(opts) {
      const info = await transporter.sendMail(opts as nodemailer.SendMailOptions);
      return { messageId: info.messageId };
    },
    async verify() {
      await transporter.verify();
      return true as const;
    },
  };
}

type ChannelRow = typeof nbfcNotificationChannels.$inferSelect;

async function loadConfig(tenantId?: string | null): Promise<ChannelRow | null> {
  if (!tenantId) return null;
  const [row] = await db
    .select()
    .from(nbfcNotificationChannels)
    .where(eq(nbfcNotificationChannels.tenant_id, tenantId))
    .limit(1);
  return row ?? null;
}

function globalTransport(): ResolvedEmail {
  // Platform-global gateway: AgentMail when configured, else SMTP — resolved by
  // the shared mailer so provider selection lives in one place.
  return {
    transporter: getMailer(),
    from: process.env.MAIL_FROM || process.env.SMTP_USER || process.env.AGENTMAIL_INBOX || "",
    source: "global",
  };
}

/**
 * Resolve the email transport for a tenant. Returns the NBFC's own SMTP when it
 * has opted into 'own_smtp' with complete settings; otherwise the global env
 * transport. Never throws for a tenant that simply hasn't configured email.
 */
export async function getEmailTransport(tenantId?: string | null): Promise<ResolvedEmail> {
  const cfg = await loadConfig(tenantId);
  if (cfg && cfg.email_mode === "own_smtp" && cfg.smtp_host && cfg.smtp_port && cfg.smtp_user && cfg.smtp_pass) {
    const fromAddr = cfg.email_from || cfg.smtp_user;
    const from = cfg.email_from_name ? `"${cfg.email_from_name}" <${fromAddr}>` : fromAddr;
    return {
      transporter: wrapNodemailer(
        nodemailer.createTransport({
          host: cfg.smtp_host,
          port: cfg.smtp_port,
          secure: cfg.smtp_secure,
          auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
        }),
      ),
      from,
      source: "tenant",
    };
  }
  return globalTransport();
}

export interface ResolvedSms {
  provider: "gupshup" | "decentro" | "global";
  /** When tenant-specific creds are present, the caller should pass them through. */
  apiKey?: string | null;
  source?: string | null;
  dltTemplateId?: string | null;
}

/**
 * Resolve the SMS gateway selection for a tenant. v1 keeps the actual send going
 * through `sendKycSms` (global env), but surfaces whether the tenant configured
 * its own provider so a future send path can honour it. Returns 'global' when
 * the tenant is on the default.
 */
export async function getSmsConfig(tenantId?: string | null): Promise<ResolvedSms> {
  const cfg = await loadConfig(tenantId);
  if (cfg && cfg.sms_provider && cfg.sms_provider !== "itarang_default") {
    return {
      provider: cfg.sms_provider === "decentro" ? "decentro" : "gupshup",
      apiKey: cfg.sms_api_key,
      source: cfg.sms_source,
      dltTemplateId: cfg.sms_dlt_template_id,
    };
  }
  return { provider: "global" };
}

/** Test-send helper for the settings UI: sends a plain email via the resolved transport. */
export async function sendTestEmail(tenantId: string, toEmail: string): Promise<{ ok: boolean; via: string }> {
  const { transporter, from, source } = await getEmailTransport(tenantId);
  await transporter.sendMail({
    from,
    to: toEmail,
    subject: "iTarang — notification channel test",
    text: "This is a test message confirming your iTarang notification email gateway is working.",
  });
  return { ok: true, via: source };
}

/** Test-send helper for the settings UI: sends a test SMS (global path in v1). */
export async function sendTestSms(_tenantId: string, mobile: string): Promise<SendSmsResult> {
  return sendKycSms({
    mobile_number: mobile,
    message: "iTarang: notification channel test. Your SMS gateway is reachable.",
  });
}
