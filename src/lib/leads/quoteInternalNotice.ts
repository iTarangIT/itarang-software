/**
 * The internal copy of a WhatsApp-only quotation send.
 *
 * WhatsApp has no CC. When a quotation goes to a dealer on WhatsApp WITHOUT
 * the email channel, the E-297 CC list (owner, sender, admin fixed list,
 * extras) would otherwise hear nothing — so they get this plain email instead,
 * with the PDF attached. It costs nothing on WhatsApp and needs no template.
 *
 * It deliberately carries NO approval link. That link is signed for the
 * dealer; a teammate clicking it from their inbox would answer the quotation
 * on the dealer's behalf.
 *
 * Pure — no I/O — so it is unit-tested.
 */

export interface QuoteInternalNoticeInput {
  quoteNumber: string;
  dealerName: string | null;
  /** Grand total from the rendered quotation; null prints no amount. */
  total: number | null;
  /** The WhatsApp number the quotation actually went to. */
  phone: string;
  senderName: string | null;
  /** The covering note the dealer received, if one was typed. */
  note: string | null;
}

export interface QuoteInternalNotice {
  subject: string;
  text: string;
  html: string;
}

export function formatInr(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildQuoteInternalNotice(
  input: QuoteInternalNoticeInput,
): QuoteInternalNotice {
  const dealer = input.dealerName?.trim() || "the dealer";
  const amount =
    input.total != null && Number.isFinite(input.total) ? `₹${formatInr(input.total)}` : null;
  const phone = input.phone.startsWith("+") ? input.phone : `+${input.phone}`;
  const sender = input.senderName?.trim() || null;
  const note = input.note?.trim() || null;

  const subject =
    `Quote ${input.quoteNumber} sent to ${dealer} on WhatsApp` + (amount ? `, ${amount}` : "");

  const rows: [string, string][] = [
    ["Quotation", input.quoteNumber],
    ["Dealer", dealer],
    ["WhatsApp", phone],
    ...(amount ? ([["Amount", amount]] as [string, string][]) : []),
    ...(sender ? ([["Sent by", sender]] as [string, string][]) : []),
  ];

  const footer =
    "Internal notification — the dealer received this quotation on WhatsApp. " +
    "The PDF they were sent is attached. Do not forward this email to the dealer.";

  const text =
    `Quotation ${input.quoteNumber} was sent to ${dealer} on WhatsApp.\n\n` +
    rows.map(([k, v]) => `${k}: ${v}`).join("\n") +
    (note ? `\n\nCovering note sent to the dealer:\n${note}` : "") +
    `\n\n${footer}`;

  const html =
    `<p>Quotation <b>${escapeHtml(input.quoteNumber)}</b> was sent to ` +
    `<b>${escapeHtml(dealer)}</b> on WhatsApp.</p>` +
    `<table style="border-collapse:collapse;font-size:14px">` +
    rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:2px 16px 2px 0;color:#64748b">${escapeHtml(k)}</td>` +
          `<td style="padding:2px 0">${escapeHtml(v)}</td></tr>`,
      )
      .join("") +
    `</table>` +
    (note
      ? `<p style="margin-top:16px;color:#64748b">Covering note sent to the dealer:</p>` +
        `<p style="white-space:pre-wrap">${escapeHtml(note)}</p>`
      : "") +
    `<p style="margin-top:16px;font-size:12px;color:#64748b">${escapeHtml(footer)}</p>`;

  return { subject, text, html };
}
