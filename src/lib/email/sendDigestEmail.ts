/**
 * The scheduled digest email (E-285, generalised by E-286).
 *
 * ONE TEMPLATE, EVERY KIND, TWO MOMENTS: the 09:00 IST send that reports
 * YESTERDAY and the 19:00 IST send that reports TODAY SO FAR. What differs
 * between Dealer Validation and KYC Review is entirely data — the figures, the
 * heading, the button — so it arrives through the descriptor rather than through
 * a second copy of this file.
 *
 * WHY THIS EXISTS AT ALL, GIVEN emit() ALREADY SENDS EMAIL
 *   emit() mails a title, a paragraph and a link, per NOTIFICATION. This is the
 *   opposite shape: nothing happened just now, and the point is the ARITHMETIC
 *   over a whole day. There is no notification type to hang it on and nothing for
 *   the Settings → Email Notification grid to govern, so — like the ~16 other
 *   bespoke senders in this directory — it calls getMailer() directly and is
 *   controlled by its own screen.
 *
 * NEVER THROWS. A digest is a convenience; a mail provider having a bad minute
 * must not take down the ticker. The error comes back in the return value and the
 * engine records it on the ledger row, so a broken mailbox is visible on the
 * settings screen rather than only in a log.
 */
import type {
  ActivityLine,
  BacklogLine,
  DigestDetail,
  DigestDetailRow,
  DigestFigures,
  DigestKindDescriptor,
} from "@/lib/digests/types";
import type { DigestDetailLevel, DigestSections } from "@/lib/digests/schedule";
import { getMailer } from "./mailer";

function esc(v: unknown): string {
  const s = v == null ? "" : String(v);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "Sat 6 Sept" — how both the subject and the heading name a covered day. */
function istDayLabel(istDay: string): string {
  // istDay is already an IST calendar date; parse it as UTC noon so no timezone
  // can shunt it onto a neighbouring day while formatting.
  const d = new Date(`${istDay}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return istDay;
  return d.toLocaleDateString("en-IN", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** The palette, inlined — no stylesheet survives an email client. */
const NAVY = "#0f2540";
const TEAL = "#0f766e";
const SLATE = "#334155";
const MUTED = "#64748b";

export type DigestEmailSlot = "morning" | "evening" | "test";

const COPY: Record<
  DigestEmailSlot,
  { accent: string; eyebrow: string; period: (day: string) => string }
> = {
  morning: { accent: NAVY, eyebrow: "Morning update", period: (d) => `Yesterday · ${d}` },
  evening: { accent: TEAL, eyebrow: "Evening update", period: (d) => `Today so far · ${d}` },
  test: { accent: MUTED, eyebrow: "Test send", period: (d) => `Sample · ${d}` },
};

function appUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    "https://app.itarang.com"
  ).replace(/\/+$/, "");
}

/**
 * At most this many rows are listed per bucket in a `detailed` mail. Beyond it
 * the mail says "+N more" and points at the page — an email is a summary, and a
 * 200-name list in an inbox is not more informative, just longer. The Excel
 * attachment is uncapped for exactly this reason.
 */
export const DETAIL_ROW_CAP = 15;

export interface DigestEmailPayload {
  kind: DigestKindDescriptor;
  to: string[];
  slot: DigestEmailSlot;
  /** The IST calendar day the figures cover, YYYY-MM-DD. */
  istDay: string;
  figures: DigestFigures;
  /** Figures only, or figures plus the rows behind them. Defaults to summary. */
  detail?: DigestDetailLevel;
  detailRows?: DigestDetail;
  /** Which sections to render. Defaults to all. */
  sections?: DigestSections;
  attachment?: { filename: string; content: Buffer; contentType: string } | null;
}

/** One row in a detailed list: title — subtitle · city. */
function rowLine(d: DigestDetailRow): string {
  const where = [d.subtitle, d.city].filter(Boolean).join(" · ");
  return where ? `${d.title} — ${where}` : d.title;
}

/**
 * Build the message without sending it.
 *
 * Split from the send so the template can be rendered — by a test, or by
 * `scripts/verify-digests.ts --render` — without a mail provider and without
 * putting anything in anybody's inbox. Reviewing a template you cannot look at
 * until it has already been mailed is how a broken layout reaches a recipient.
 */
export function buildDigestEmail(
  p: DigestEmailPayload,
): { subject: string; html: string; text: string } {
  const copy = COPY[p.slot] ?? COPY.morning;
  const dayLabel = istDayLabel(p.istDay);
  const href = `${appUrl()}${p.kind.ctaHref}`;
  const detailed = p.detail === "detailed";

  // A section absent from the map defaults to ON, so a descriptor that gains a
  // section does not have it silently hidden for everyone who saved before.
  const on = (key: string) => p.sections?.[key] !== false;

  const activity: ActivityLine[] = p.figures.activity.filter((l) => on(l.key));
  const backlog: BacklogLine[] = p.figures.backlog.filter((l) => on(l.key));

  const activityRows = activity
    .map(
      (l) => `
      <tr>
        <td style="padding:${l.indent ? "3px 16px 3px 14px" : "7px 16px 7px 0"};color:${MUTED};
          font-size:${l.indent ? "11px" : "12px"};letter-spacing:.06em;
          text-transform:uppercase;white-space:nowrap">${esc(l.label)}</td>
        <td style="padding:${l.indent ? "3px 0" : "7px 0"};color:${l.indent ? MUTED : NAVY};
          font-size:${l.indent ? "14px" : "20px"};font-weight:${l.indent ? 600 : 700};
          text-align:right">${esc(l.value)}</td>
      </tr>`,
    )
    .join("");

  const backlogRows = backlog
    .map(
      (l) => `
      <tr>
        <td style="padding:7px 16px 7px 0;color:${MUTED};font-size:12px;
          letter-spacing:.06em;text-transform:uppercase;white-space:nowrap">${esc(l.label)}</td>
        <td style="padding:7px 0;color:${SLATE};font-size:${l.display ? "15px" : "20px"};
          font-weight:700;text-align:right">${esc(l.display ?? l.value)}</td>
      </tr>`,
    )
    .join("");

  // In `detailed`, each non-zero line with a bucket is followed by its rows.
  // Zero lines are skipped entirely rather than printed with an empty list —
  // "Rejected 0" followed by a blank heading reads as a rendering fault.
  const detailBlocks = !detailed
    ? ""
    : activity
        .filter((l) => l.bucket && l.value > 0 && !l.indent)
        .map((l) => {
          const all = p.detailRows?.[l.bucket!] ?? [];
          const shown = all.slice(0, DETAIL_ROW_CAP);
          const more = l.value - shown.length;
          const items = shown
            .map((d) => `<li style="margin:0 0 4px">${esc(rowLine(d))}</li>`)
            .join("");
          const overflow =
            more > 0 ? `<li style="margin:0 0 4px;color:${MUTED}">+${more} more</li>` : "";
          return `
      <p style="margin:18px 0 4px;color:${MUTED};font-size:11px;letter-spacing:.14em;
        text-transform:uppercase;font-family:Arial,sans-serif">${esc(l.label)} (${l.value})</p>
      <ul style="margin:0;padding:0 0 0 18px;font-size:14px;color:${SLATE}">
        ${items}${overflow}
      </ul>`;
        })
        .join("");

  const html = `
  <div style="font-family:Georgia,'Iowan Old Style',Palatino,serif;font-size:14px;
    color:#0f172a;max-width:560px">
    <p style="margin:0 0 4px;color:${copy.accent};font-size:11px;letter-spacing:.14em;
      text-transform:uppercase;font-family:Arial,sans-serif">${esc(copy.eyebrow)}</p>
    <h1 style="margin:0 0 6px;font-size:24px;line-height:1.25;color:${NAVY}">
      ${esc(p.kind.label)}</h1>
    <p style="margin:0 0 22px;color:${SLATE};font-size:15px">${esc(copy.period(dayLabel))}</p>
    ${
      activity.length
        ? `<table role="presentation" cellpadding="0" cellspacing="0"
             style="border-collapse:collapse;width:100%;margin:0 0 8px;
             font-family:Arial,sans-serif">${activityRows}</table>`
        : ""
    }
    ${detailBlocks}
    ${
      backlog.length
        ? `<p style="margin:26px 0 6px;color:${MUTED};font-size:11px;letter-spacing:.14em;
             text-transform:uppercase;font-family:Arial,sans-serif">Still outstanding</p>
           <table role="presentation" cellpadding="0" cellspacing="0"
             style="border-collapse:collapse;width:100%;margin:0 0 24px;
             font-family:Arial,sans-serif;border-top:1px solid #e2e8f0">${backlogRows}</table>`
        : ""
    }
    <p style="margin:0 0 22px">
      <a href="${esc(href)}" style="background:${copy.accent};color:#fff;text-decoration:none;
        padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block;
        font-family:Arial,sans-serif;font-size:14px">${esc(p.kind.ctaLabel)}</a>
    </p>
    <p style="color:#94a3b8;font-size:12px;font-family:Arial,sans-serif;margin:0 0 6px">
      If the button doesn't work, paste this link into your browser:<br>${esc(href)}
    </p>
    ${
      p.attachment
        ? `<p style="color:#94a3b8;font-size:12px;font-family:Arial,sans-serif;margin:0 0 6px">
             Attached: <strong>${esc(p.attachment.filename)}</strong> — every item in the
             figures above, one row each.
           </p>`
        : ""
    }
    <p style="color:#94a3b8;font-size:12px;font-family:Arial,sans-serif;margin:0">
      Sent twice a day by iTarang. Change the times, the recipients or what this
      email contains at Settings → ${esc(p.kind.label)}.
    </p>
  </div>`;

  // The plain-text sibling is built from the SAME filtered arrays, so a section
  // switched off, or a detail list, cannot appear in one body and not the other.
  const textParts: string[] = [
    copy.eyebrow.toUpperCase(),
    `${p.kind.label} — ${copy.period(dayLabel)}`,
  ];
  if (activity.length) {
    textParts.push("", ...activity.map((l) => `${l.indent ? "  " : ""}${l.label}: ${l.value}`));
  }
  if (detailed) {
    for (const l of activity) {
      if (!l.bucket || l.value === 0 || l.indent) continue;
      const all = p.detailRows?.[l.bucket] ?? [];
      const shown = all.slice(0, DETAIL_ROW_CAP);
      const more = l.value - shown.length;
      textParts.push("", `${l.label.toUpperCase()} (${l.value})`);
      for (const d of shown) textParts.push(`  - ${rowLine(d)}`);
      if (more > 0) textParts.push(`  - +${more} more`);
    }
  }
  if (backlog.length) {
    textParts.push(
      "",
      "STILL OUTSTANDING",
      ...backlog.map((l) => `${l.label}: ${l.display ?? l.value}`),
    );
  }
  if (p.attachment) textParts.push("", `Attached: ${p.attachment.filename}`);
  textParts.push("", `${p.kind.ctaLabel}: ${href}`);

  const subject =
    p.slot === "evening"
      ? `[iTarang] ${p.kind.label} — today (${dayLabel})`
      : p.slot === "test"
        ? `[iTarang] ${p.kind.label} — test send (${dayLabel})`
        : `[iTarang] ${p.kind.label} — yesterday (${dayLabel})`;

  return { subject, html, text: textParts.join("\n") };
}

export async function sendDigestEmail(
  p: DigestEmailPayload,
): Promise<{ ok: boolean; messageId: string | null; error?: string }> {
  const { subject, html, text } = buildDigestEmail(p);

  try {
    const transporter = getMailer();
    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      // An ARRAY, not a comma-joined string: AgentMail validates a bare string as
      // a single address and 400s a joined list of several. See mailer.ts.
      to: p.to,
      subject,
      text,
      html,
      attachments: p.attachment ? [p.attachment] : undefined,
    });

    if (info.rejected && info.rejected.length > 0) {
      return {
        ok: false,
        messageId: info.messageId ?? null,
        error: `SMTP rejected: ${info.rejected
          .map((r) => (typeof r === "string" ? r : r.address))
          .join(", ")}`,
      };
    }

    return { ok: true, messageId: info.messageId ?? null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[digest:${p.kind.id}] send failed:`, error);
    return { ok: false, messageId: null, error };
  }
}
