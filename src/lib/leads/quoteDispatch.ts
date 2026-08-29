/**
 * E-242 — putting an approved quotation in front of the dealer.
 *
 * ## The channels are independent, and that is the whole design
 *
 * A send names one or two channels. Each is attempted on its own, each writes
 * its own `quotation_dispatches` row, and neither can undo the other. WhatsApp
 * being misconfigured must not retract an email that has already landed in a
 * dealer's inbox — there is no such thing as un-sending it, so the record has to
 * be able to say "email sent, WhatsApp failed" rather than collapsing to one
 * verdict.
 *
 * ## Bytes, not links
 *
 * The generated PDF lives behind `/api/files/<bucket>/<key>`, which requires a
 * session. Meta cannot fetch that, so `sendDocument(link)` would hand the
 * provider a URL it gets a login page from. The bytes are read out of storage
 * and uploaded instead — the reason `sendDocumentBytes` exists, and the same
 * approach src/lib/nbfc/auction/notify.ts takes for battery photos.
 *
 * ## What this module will NOT do
 *
 * Capture the dealer's reply. Approving a quotation over WhatsApp or email is
 * explicitly a later phase. The dispatch row is the anchor a future inbound
 * handler would match a reply against, which is why `provider_message_id` is
 * recorded even though nothing reads it yet.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { downloadPdfBuffer } from "@/lib/email/downloadPdfBuffer";
import { sendEmail } from "@/lib/email/mailer";
import { normalizePhone } from "@/lib/leads/dedupe-rules";
import { quotationFileName } from "@/lib/leads/quote-pdf/numbering";
import { quoteApprovalUrl } from "@/lib/leads/quoteToken";
import {
  QUOTE_APPROVE_PREFIX,
  QUOTE_DECLINE_PREFIX,
} from "@/lib/whatsapp/quotationButton";
import { getAdapter } from "@/lib/whatsapp";

export { quotationFileName };

/**
 * E-243 — the signed page where the dealer answers.
 *
 * Best-effort: if no signing secret is configured, minting throws and the
 * quotation still goes out without a response link. A missing env var must not
 * stop a dealer receiving their quotation — it only costs the capture, which is
 * the additive half of this feature.
 */
function approvalLink(input: DispatchQuotationInput): string | null {
  try {
    return quoteApprovalUrl({
      commercialId: input.commercialId,
      versionNo: input.versionNo,
    });
  } catch (e) {
    console.error("[quoteDispatch] approval link unavailable", e);
    return null;
  }
}

export const QUOTE_DISPATCH_CHANNELS = ["email", "whatsapp"] as const;
export type QuoteDispatchChannel = (typeof QUOTE_DISPATCH_CHANNELS)[number];

export interface DispatchOutcome {
  channel: QuoteDispatchChannel;
  recipient: string;
  status: "sent" | "failed";
  providerMessageId?: string | null;
  error?: string;
}

export interface DispatchQuotationInput {
  commercialId: string;
  dealerLeadId: string;
  versionNo: number;
  quoteNumber: string;
  pdfUrl: string;
  dealerName: string | null;
  channels: QuoteDispatchChannel[];
  /** Recipient email, already validated by the route. */
  email?: string | null;
  /** Recipient phone, free-form; normalised here. */
  phone?: string | null;
  /** Optional covering note from the sales manager. */
  message?: string | null;
  sentBy: string;
}

function greeting(dealerName: string | null): string {
  const name = dealerName?.trim();
  return name ? `Dear ${name},` : "Hello,";
}

function defaultBody(quoteNumber: string, dealerName: string | null): string {
  return (
    `${greeting(dealerName)}\n\n` +
    `Please find attached our quotation ${quoteNumber}.\n\n` +
    `Do let us know if you have any questions.\n\n` +
    `Regards,\niTarang Technologies LLP`
  );
}

/**
 * Record one channel's outcome.
 *
 * Best-effort and never throws: the message has already gone (or already
 * failed), and losing the log entry must not turn a delivered quotation into a
 * 500 that invites the sales manager to send it a second time.
 */
async function logDispatch(
  input: DispatchQuotationInput,
  outcome: DispatchOutcome,
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO quotation_dispatches
        (commercial_id, dealer_lead_id, channel, recipient, status,
         provider_message_id, error, sent_by)
      VALUES
        (${input.commercialId}::uuid, ${input.dealerLeadId}, ${outcome.channel},
         ${outcome.recipient}, ${outcome.status},
         ${outcome.providerMessageId ?? null}, ${outcome.error ?? null},
         ${input.sentBy})
    `);
  } catch (e) {
    console.error("[quoteDispatch] could not log dispatch", {
      commercialId: input.commercialId,
      channel: outcome.channel,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function dispatchEmail(
  input: DispatchQuotationInput,
  pdf: Buffer | null,
): Promise<DispatchOutcome> {
  const to = (input.email ?? "").trim();
  if (!to) {
    return {
      channel: "email",
      recipient: "",
      status: "failed",
      error: "No email address for this dealer.",
    };
  }
  // Unlike a welcome email, the attachment IS the message here. Sending the
  // covering note without the quotation would tell a dealer a quotation exists
  // and give them no way to read it.
  if (!pdf) {
    return {
      channel: "email",
      recipient: to,
      status: "failed",
      error: "The quotation PDF could not be read from storage.",
    };
  }

  const body = input.message?.trim() || defaultBody(input.quoteNumber, input.dealerName);
  const link = approvalLink(input);

  // E-243 — the response link. The PDF is still attached, so a dealer who never
  // clicks anything has lost nothing; the button is how the answer gets back to
  // us instead of into somebody's inbox.
  const linkText = link
    ? `\n\nApprove or respond to this quotation here:\n${link}\n`
    : "";
  const linkHtml = link
    ? `<p style="margin:24px 0">
         <a href="${link}"
            style="background:#059669;color:#fff;padding:12px 22px;border-radius:8px;
                   text-decoration:none;font-weight:600;display:inline-block">
           Review &amp; respond
         </a>
       </p>
       <p style="font-size:12px;color:#64748b">
         Or copy this link: <a href="${link}">${link}</a>
       </p>`
    : "";

  try {
    const res = await sendEmail({
      to,
      subject: `Quotation ${input.quoteNumber} from iTarang Technologies LLP`,
      text: body + linkText,
      html: `<p>${body.replace(/\n/g, "<br/>")}</p>${linkHtml}`,
      attachments: [
        {
          filename: quotationFileName(input.quoteNumber),
          content: pdf,
          contentType: "application/pdf",
        },
      ],
    });
    return {
      channel: "email",
      recipient: to,
      status: "sent",
      providerMessageId: res.messageId ?? null,
    };
  } catch (e) {
    return {
      channel: "email",
      recipient: to,
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function dispatchWhatsApp(
  input: DispatchQuotationInput,
  pdf: Buffer | null,
): Promise<DispatchOutcome> {
  const normalized = normalizePhone(input.phone ?? "");
  if (!normalized) {
    return {
      channel: "whatsapp",
      recipient: (input.phone ?? "").trim(),
      status: "failed",
      error: "No valid mobile number for this dealer.",
    };
  }
  // The adapter wants E.164 WITHOUT the leading '+'.
  const to = normalized.replace(/^\+/, "");

  if (!pdf) {
    return {
      channel: "whatsapp",
      recipient: to,
      status: "failed",
      error: "The quotation PDF could not be read from storage.",
    };
  }

  const link = approvalLink(input);
  const caption =
    (input.message?.trim() ||
      `Quotation ${input.quoteNumber} from iTarang Technologies LLP`) +
    // The link goes in the caption as well as the buttons below, because
    // interactive messages need the 24-hour customer-service window and a link
    // does not. If the buttons never arrive, the dealer can still answer.
    (link ? `\n\nApprove or respond: ${link}` : "");

  try {
    // Bytes rather than a link: the PDF sits behind the authenticated files
    // proxy, which the provider cannot fetch.
    const res = await getAdapter().sendDocumentBytes(
      to,
      pdf,
      "application/pdf",
      quotationFileName(input.quoteNumber),
      caption,
    );

    // E-243 — tappable Approve / Decline, sent as a SEPARATE message after the
    // document. Best-effort and deliberately not part of the outcome: the
    // quotation has already been delivered, and a failed button message (most
    // likely because the 24h window has closed) must not report the send as
    // failed and invite a duplicate. The caption's link still works.
    if (res.ok) {
      try {
        await getAdapter().sendInteractive(
          to,
          `Quotation ${input.quoteNumber} — please review the document above and let us know.`,
          [
            // Titles are capped at 20 characters by WhatsApp; the IDs carry the
            // quotation and are what quotationReply.ts matches on.
            { id: `${QUOTE_APPROVE_PREFIX}${input.commercialId}`, title: "Approve" },
            { id: `${QUOTE_DECLINE_PREFIX}${input.commercialId}`, title: "Not right now" },
          ],
        );
      } catch (e) {
        console.error("[quoteDispatch] approval buttons not sent", e);
      }
    }

    return {
      channel: "whatsapp",
      recipient: to,
      status: res.ok ? "sent" : "failed",
      providerMessageId: res.providerMessageId,
      // A provider that answers "not ok" without saying why is still a failure
      // the sales manager has to be told about.
      error: res.ok ? undefined : res.error || "The provider rejected the message.",
    };
  } catch (e) {
    return {
      channel: "whatsapp",
      recipient: to,
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Send the quotation over every requested channel and record each result.
 *
 * Never throws. The caller reports per-channel outcomes to the sales manager,
 * who is the only one who can decide whether a partial send needs a retry.
 */
export async function dispatchQuotation(
  input: DispatchQuotationInput,
): Promise<DispatchOutcome[]> {
  // Read the document once even when both channels are used — it is the same
  // bytes and storage is the slowest part of this.
  const pdf = await downloadPdfBuffer(input.pdfUrl);

  const wanted = [...new Set(input.channels)];
  const outcomes = await Promise.all(
    wanted.map((channel) =>
      channel === "email" ? dispatchEmail(input, pdf) : dispatchWhatsApp(input, pdf),
    ),
  );

  // Logged after both have been attempted, so one channel's slow provider does
  // not delay the other's send.
  await Promise.all(outcomes.map((o) => logDispatch(input, o)));

  return outcomes;
}

export interface DispatchHistoryRow {
  dispatch_id: string;
  channel: string;
  recipient: string;
  status: string;
  error: string | null;
  sent_by_name: string | null;
  created_at: string;
}

/** Every send attempt for one quotation, newest first. */
export async function listDispatches(
  commercialId: string,
): Promise<DispatchHistoryRow[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT d.dispatch_id::text AS dispatch_id, d.channel, d.recipient, d.status,
           d.error, d.created_at, u.name AS sent_by_name
      FROM quotation_dispatches d
      -- sent_by is text and users.id is uuid: cast the uuid, never the text, so
      -- a non-uuid sent_by cannot take the whole panel down.
      LEFT JOIN users u ON u.id::text = d.sent_by
     WHERE d.commercial_id = ${commercialId}::uuid
     ORDER BY d.created_at DESC
     LIMIT 50
  `);
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    dispatch_id: String(r.dispatch_id),
    channel: String(r.channel),
    recipient: String(r.recipient),
    status: String(r.status),
    error: r.error == null ? null : String(r.error),
    sent_by_name: r.sent_by_name == null ? null : String(r.sent_by_name),
    created_at: new Date(r.created_at as string).toISOString(),
  }));
}
