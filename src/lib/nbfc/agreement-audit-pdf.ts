/**
 * iTarang loan-agreement AUDIT RECORD PDF (fallback).
 *
 * The "Download audit trail" button normally serves the eSign provider's
 * official audit certificate. When that certificate does not exist — the
 * agreement was recorded as signed manually (no provider e-sign), or the
 * provider document lives in a different environment — there is no provider
 * trail to fetch. Rather than fail, we generate iTarang's OWN signing/audit
 * record from our immutable data so the operator always gets a meaningful PDF.
 *
 * This is iTarang's record, NOT the provider's legal eSign certificate; the PDF
 * states so. §5.4 vendor abstraction: never names the underlying provider.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface AgreementAuditInput {
  leadId: string;
  agreementRef: string;
  nbfcName: string;
  customerName: string;
  customerEmail: string | null;
  status: string;
  initiatedAt: Date | null;
  signedAt: Date | null;
  signers: Array<{ name: string; email: string | null }>;
  generatedAt: Date;
}

function fmt(d: Date | null): string {
  if (!d) return "—";
  try {
    return new Intl.DateTimeFormat("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
    }).format(d) + " IST";
  } catch {
    return d.toISOString();
  }
}

function wrap(input: unknown, max: number): string[] {
  // Coerce defensively — row values may arrive as numbers/Dates (e.g. a serial
  // PK), and pdf-lib only draws strings.
  const s = input == null || input === "" ? "—" : String(input);
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : ["—"];
}

export interface AuditRecordRow {
  label: string;
  value: string;
}

/**
 * Generic iTarang audit-record PDF: a navy header, an intro disclaimer, a list
 * of label/value rows, and a footer note. Used by both the loan-agreement and
 * LSP-agreement audit-trail fallbacks.
 */
export async function generateAuditRecordPdf(opts: {
  title: string;
  intro: string[];
  rows: AuditRecordRow[];
  footerNote: string;
  generatedAt: Date;
}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4 portrait
  const { width } = page.getSize();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(0.06, 0.15, 0.25);
  const slate = rgb(0.3, 0.35, 0.42);
  const white = rgb(1, 1, 1);
  const M = 50;

  // pdf-lib's standard fonts use WinAnsi and throw on characters they can't
  // encode (e.g. ↔, emoji, non-Latin names). Draw normally, but on an encode
  // error fall back to an ASCII-only rendering so generation never crashes.
  const draw = (s: string, x: number, y: number, f = font, size = 10, color = slate) => {
    try {
      page.drawText(s, { x, y, font: f, size, color });
    } catch {
      page.drawText(s.replace(/[^\x20-\x7E]/g, "?"), { x, y, font: f, size, color });
    }
  };

  page.drawRectangle({ x: 0, y: 798, width, height: 44, color: navy });
  draw(opts.title, M, 814, bold, 14, white);

  let y = 766;
  for (const line of opts.intro) {
    draw(line, M, y, font, 9, slate);
    y -= 13;
  }
  y -= 14;

  for (const r of opts.rows) {
    draw(r.label, M, y, bold, 10, navy);
    const lines = wrap(r.value, 62);
    lines.forEach((ln, i) => draw(ln, M + 165, y - i * 13, font, 10, slate));
    y -= Math.max(1, lines.length) * 13 + 8;
  }

  page.drawRectangle({ x: 0, y: 0, width, height: 40, color: rgb(0.96, 0.97, 0.98) });
  draw(`Generated ${fmt(opts.generatedAt)} · iTarang Technologies LLP`, M, 24, font, 8, slate);
  draw(opts.footerNote, M, 12, font, 7, slate);

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

export async function generateAgreementAuditPdf(input: AgreementAuditInput): Promise<Buffer> {
  const rows: AuditRecordRow[] = [
    { label: "Lead ID", value: input.leadId },
    { label: "Agreement reference", value: input.agreementRef },
    { label: "NBFC (lender)", value: input.nbfcName || "—" },
    { label: "Customer", value: `${input.customerName}${input.customerEmail ? `  <${input.customerEmail}>` : ""}` },
    { label: "Signing method", value: "iTarang eSign" },
    { label: "Status", value: input.status },
    { label: "Initiated", value: fmt(input.initiatedAt) },
    { label: "Signed / recorded", value: fmt(input.signedAt) },
    ...input.signers.map((s, i) => ({
      label: `Signatory ${i + 1}`,
      value: `${s.name || "—"}${s.email ? `  <${s.email}>` : ""}`,
    })),
  ];
  return generateAuditRecordPdf({
    title: "iTarang — Loan Agreement Audit Record",
    intro: [
      "iTarang's internal signing/audit record for this loan agreement, generated from",
      "iTarang's immutable records. This is NOT the eSign provider's legal certificate —",
      "when that certificate is available, it is provided instead of this record.",
    ],
    rows,
    footerNote: "§17.4–17.6 — document storage is optional; the Step-5 OTP (dealer side) is the hard disbursal gate.",
    generatedAt: input.generatedAt,
  });
}
