import { NextRequest, NextResponse } from "next/server";
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import { requireSecurityAdmin } from "@/lib/security/route-guard";
import { loadReportData, filtersFromSearchParams } from "@/lib/security/report-data";
import { SEVERITIES, SEVERITY_LABELS } from "@/lib/security/severity";
import { CATEGORY_LABELS } from "@/lib/security/types";

export const dynamic = "force-dynamic";

const SEV_HEX: Record<string, string> = {
  critical: "B91C1C",
  high: "EA580C",
  medium: "D97706",
  low: "0284C7",
  info: "64748B",
};

export async function GET(req: NextRequest) {
  const auth = await requireSecurityAdmin();
  if (!auth.ok) return auth.response;

  try {
    const data = await loadReportData(filtersFromSearchParams(req.nextUrl.searchParams));
    const generated = data.generatedAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

    const children: Paragraph[] = [
      new Paragraph({ text: "iTarang CRM — Security Findings Report", heading: HeadingLevel.TITLE }),
      new Paragraph({
        children: [
          new TextRun({
            text: `Generated ${generated} · ${
              data.run
                ? `Target: ${data.run.target_env} (${data.run.mode} mode) · ${data.run.target_base_url}`
                : "No scan run recorded"
            } · ${data.findings.length} finding(s)`,
            italics: true,
            color: "64748B",
          }),
        ],
      }),
      new Paragraph({ text: "Summary", heading: HeadingLevel.HEADING_2 }),
      new Paragraph({
        children: SEVERITIES.map(
          (s) =>
            new TextRun({
              text: `  ${SEVERITY_LABELS[s]}: ${data.counts[s]}   `,
              bold: true,
              color: SEV_HEX[s],
            }),
        ),
      }),
      new Paragraph({ text: "Findings", heading: HeadingLevel.HEADING_2 }),
    ];

    if (data.findings.length === 0) {
      children.push(new Paragraph({ text: "No findings match the selected filters." }));
    }

    data.findings.forEach((f, i) => {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          children: [
            new TextRun({ text: `[${SEVERITY_LABELS[f.severity]}] `, bold: true, color: SEV_HEX[f.severity] }),
            new TextRun({ text: `#${i + 1} ${f.title}`, bold: true }),
          ],
        }),
        new Paragraph({
          children: [new TextRun({ text: `${CATEGORY_LABELS[f.category]} · ${f.confidence} · ${f.status}`, color: "64748B" })],
        }),
        new Paragraph({ text: f.summary }),
        kv("Target", `${f.http_method || ""} ${f.target_url}`.trim()),
      );
      if (f.reproduction) children.push(kv("Reproduction", f.reproduction));
      if (f.remediation) children.push(kv("Remediation", f.remediation));
      children.push(kv("Refs", [f.owasp_ref, f.cwe_ref, f.check_slug].filter(Boolean).join(" · ")));
    });

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);
    const today = new Date().toISOString().slice(0, 10);
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="security-findings-${today}.docx"`,
        "Content-Length": buffer.byteLength.toString(),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("SECURITY REPORT DOCX ERROR:", error);
    return NextResponse.json({ success: false, message: "Failed to render Word document" }, { status: 500 });
  }
}

function kv(key: string, value: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: `${key}: `, bold: true }), new TextRun({ text: value })],
  });
}
