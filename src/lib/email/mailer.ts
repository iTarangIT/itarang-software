/**
 * Shared outbound-email transport for iTarang.
 *
 * Background: the app originally sent all mail over Hostinger SMTP
 * (`it@itarang.com`). Hostinger blocked that mailbox's outbound sending, so we
 * moved sending to the AgentMail HTTP API — no SMTP port, no IMAP (IMAP cannot
 * send), just an authenticated POST. Every email module now calls `getMailer()`
 * here instead of building its own `nodemailer.createTransport`, so switching
 * providers is a one-file change.
 *
 * Provider selection is by env:
 *   - If AGENTMAIL_API_KEY + AGENTMAIL_INBOX are set → send via AgentMail.
 *   - Otherwise fall back to classic SMTP (SMTP_HOST/PORT/USER/PASS) so nothing
 *     breaks in environments still on SMTP.
 *
 * The returned object mimics the slice of nodemailer's Transporter the call
 * sites use — `sendMail(opts) => { messageId }` and `verify()` — so the call
 * sites did not have to change.
 */
import nodemailer from "nodemailer";

export interface MailAttachment {
  filename: string;
  /** Buffer (preferred) or a string body — matches nodemailer's attachment shape. */
  content: Buffer | string;
  contentType?: string;
}

export interface SendMailOptions {
  from?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: MailAttachment[];
}

/**
 * What a send reports back.
 *
 * `messageId` is the only field every provider has. The rest are nodemailer's
 * per-recipient SMTP result and are absent on AgentMail (a stateless HTTP API
 * with no envelope-level accept/reject) — hence optional.
 *
 * THEY ARE HERE BECAUSE THEY WERE ALREADY BEING READ. Three call sites
 * (sendNbfcWelcomeEmail, sendDealerWelcomeEmail, sendVendorWelcomeEmail) guard
 * on `info.rejected.length > 0` to turn a refused recipient into a thrown
 * error. The SMTP adapter below used to narrow its return to `{ messageId }`,
 * so `rejected` was `undefined` at runtime and every one of those guards was
 * dead: a credentials email the server accepted but refused to deliver looked
 * exactly like a success. Passing the fields through is what makes those
 * guards real.
 */
export interface SendMailResult {
  messageId: string;
  /** SMTP only — recipients the server took. */
  accepted?: Array<string | { address: string }>;
  /** SMTP only — recipients the server refused. A non-empty array is a failure. */
  rejected?: Array<string | { address: string }>;
  response?: string;
  envelope?: unknown;
}

export interface Mailer {
  sendMail(opts: SendMailOptions): Promise<SendMailResult>;
  verify(): Promise<true>;
}

type AgentMailConfig = { apiKey: string; inbox: string; baseUrl: string };

function agentMailConfig(): AgentMailConfig | null {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  const inbox = process.env.AGENTMAIL_INBOX;
  if (!apiKey || !inbox) return null;
  const baseUrl = (process.env.AGENTMAIL_BASE_URL || "https://api.agentmail.to").replace(/\/+$/, "");
  return { apiKey, inbox, baseUrl };
}

function toBase64(content: Buffer | string): string {
  return Buffer.isBuffer(content) ? content.toString("base64") : Buffer.from(content, "utf8").toString("base64");
}

// AgentMail validates every recipient as an email, coercing a bare string into
// a single-element array. So a comma-joined string of N recipients (the shape
// most of our senders build via `recipients.join(",")`) is validated as ONE
// address and rejected with HTTP 400 "Invalid email address". Split any
// comma-joined string into a proper array so each address is validated on its
// own. nodemailer (the SMTP path) accepts arrays too, so this is safe there.
function toAddressList(value: string | string[]): string[] {
  const parts = Array.isArray(value) ? value : String(value).split(",");
  return parts.map((v) => v.trim()).filter(Boolean);
}

async function agentMailSend(cfg: AgentMailConfig, opts: SendMailOptions): Promise<{ messageId: string }> {
  // AgentMail sends *from* the inbox itself, so `from` is not part of the body
  // (the sender is care-itarang@agentmail.to). Everything else maps 1:1.
  const body: Record<string, unknown> = {
    to: toAddressList(opts.to),
    subject: opts.subject,
  };
  if (opts.cc) body.cc = toAddressList(opts.cc);
  if (opts.bcc) body.bcc = toAddressList(opts.bcc);
  if (opts.replyTo) body.reply_to = opts.replyTo;
  if (opts.text) body.text = opts.text;
  if (opts.html) body.html = opts.html;
  if (opts.attachments?.length) {
    body.attachments = opts.attachments.map((a) => ({
      filename: a.filename,
      content_type: a.contentType || "application/octet-stream",
      content: toBase64(a.content),
    }));
  }

  const url = `${cfg.baseUrl}/v0/inboxes/${encodeURIComponent(cfg.inbox)}/messages/send`;

  // Bound the request so a network stall fails fast with a real error instead of
  // hanging the whole HTTP request (the same failure mode the old SMTP timeouts
  // guarded against).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`AgentMail send failed (HTTP ${res.status}): ${errText.slice(0, 500)}`);
  }

  const data = (await res.json().catch(() => ({}))) as { message_id?: string; thread_id?: string };
  return { messageId: data.message_id || "" };
}

let smtpVerified = false;

function smtpMailer(): Mailer {
  const host = process.env.SMTP_HOST;
  const portRaw = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !portRaw || !user || !pass) {
    throw new Error(
      `Missing email configuration: set AGENTMAIL_API_KEY + AGENTMAIL_INBOX, or SMTP_HOST/PORT/USER/PASS ` +
        `(host=${Boolean(host)}, port=${Boolean(portRaw)}, user=${Boolean(user)}, pass=${Boolean(pass)})`,
    );
  }
  const port = Number(portRaw);
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
  return {
    async sendMail(opts) {
      // nodemailer's attachment field is `contentType`, matching our shape.
      const info = await transporter.sendMail(opts as nodemailer.SendMailOptions);
      // Pass the per-recipient result through — see SendMailResult for why
      // narrowing this to `{ messageId }` silently disabled every caller's
      // rejected-recipient check.
      return {
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
        response: info.response,
        envelope: info.envelope,
      };
    },
    async verify() {
      if (!smtpVerified) {
        await transporter.verify();
        smtpVerified = true;
      }
      return true as const;
    },
  };
}

/**
 * Returns the active mailer. AgentMail when configured, else SMTP. Synchronous
 * so both `getMailer()` and `await getMailer()` call styles work.
 */
export function getMailer(): Mailer {
  const am = agentMailConfig();
  if (am) {
    return {
      sendMail: (opts) => agentMailSend(am, opts),
      // AgentMail is a stateless HTTP API — nothing to pre-verify.
      verify: async () => true as const,
    };
  }
  return smtpMailer();
}

/** Convenience one-shot send used where a full transporter handle isn't needed. */
export async function sendEmail(opts: SendMailOptions): Promise<SendMailResult> {
  return getMailer().sendMail(opts);
}
