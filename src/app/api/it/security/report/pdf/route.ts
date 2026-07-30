import { NextRequest, NextResponse } from "next/server";
import { requireSecurityAdmin } from "@/lib/security/route-guard";
import { loadReportData, filtersFromSearchParams } from "@/lib/security/report-data";
import { renderPdfFromHtml } from "@/lib/pdf/render-html";
import { SEVERITIES, SEVERITY_LABELS } from "@/lib/security/severity";
import { CATEGORY_LABELS } from "@/lib/security/types";

export const dynamic = "force-dynamic";

const SEV_COLOR: Record<string, string> = {
  critical: "#b91c1c",
  high: "#ea580c",
  medium: "#d97706",
  low: "#0284c7",
  info: "#64748b",
};

function esc(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function GET(req: NextRequest) {
  const auth = await requireSecurityAdmin();
  if (!auth.ok) return auth.response;

  try {
    const data = await loadReportData(filtersFromSearchParams(req.nextUrl.searchParams));
    const generated = data.generatedAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

    const summaryChips = SEVERITIES.map(
      (s) =>
        `<span class="chip" style="background:${SEV_COLOR[s]}">${SEVERITY_LABELS[s]}: ${data.counts[s]}</span>`,
    ).join(" ");

    const findingsHtml = data.findings
      .map(
        (f, i) => `
      <div class="finding">
        <div class="fhead">
          <span class="sev" style="background:${SEV_COLOR[f.severity]}">${SEVERITY_LABELS[f.severity]}</span>
          <span class="num">#${i + 1}</span>
          <span class="cat">${esc(CATEGORY_LABELS[f.category])}</span>
          <span class="conf">${esc(f.confidence)}</span>
        </div>
        <h3>${esc(f.title)}</h3>
        <p>${esc(f.summary)}</p>
        <table class="meta">
          <tr><th>Target</th><td>${esc(f.http_method || "")} ${esc(f.target_url)}</td></tr>
          ${f.reproduction ? `<tr><th>Reproduction</th><td>${esc(f.reproduction)}</td></tr>` : ""}
          ${f.remediation ? `<tr><th>Remediation</th><td>${esc(f.remediation)}</td></tr>` : ""}
          <tr><th>Refs</th><td>${esc(f.owasp_ref || "")} ${esc(f.cwe_ref || "")} · ${esc(f.check_slug)} · ${esc(f.status)}</td></tr>
        </table>
      </div>`,
      )
      .join("");

    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      * { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
      body { color: #0f172a; font-size: 12px; }
      h1 { font-size: 22px; margin: 0 0 4px; }
      .sub { color: #64748b; font-size: 11px; margin-bottom: 12px; }
      .chip { color: #fff; padding: 3px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; }
      .summary { margin: 10px 0 18px; }
      .finding { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 10px; page-break-inside: avoid; }
      .fhead { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
      .sev { color: #fff; padding: 2px 8px; border-radius: 6px; font-size: 10px; font-weight: 700; }
      .num { color: #94a3b8; font-size: 10px; }
      .cat, .conf { font-size: 10px; color: #475569; background: #f1f5f9; padding: 2px 6px; border-radius: 4px; }
      h3 { font-size: 13px; margin: 4px 0; }
      p { margin: 4px 0; color: #334155; }
      table.meta { width: 100%; border-collapse: collapse; margin-top: 6px; }
      table.meta th { text-align: left; width: 110px; color: #64748b; font-size: 10px; vertical-align: top; padding: 2px 6px 2px 0; }
      table.meta td { font-size: 10px; color: #0f172a; word-break: break-all; padding: 2px 0; }
    </style></head><body>
      <h1>iTarang CRM — Security Findings Report</h1>
      <div class="sub">
        Generated ${esc(generated)} ·
        ${data.run ? `Target: ${esc(data.run.target_env)} (${esc(data.run.mode)} mode) · ${esc(data.run.target_base_url)}` : "No scan run recorded"} ·
        ${data.findings.length} finding(s)
      </div>
      <div class="summary">${summaryChips}</div>
      ${data.findings.length ? findingsHtml : "<p>No findings match the selected filters.</p>"}
    </body></html>`;

    const pdf = await renderPdfFromHtml(html);
    const today = new Date().toISOString().slice(0, 10);
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="security-findings-${today}.pdf"`,
        "Content-Length": pdf.byteLength.toString(),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("SECURITY REPORT PDF ERROR:", error);
    return NextResponse.json({ success: false, message: "Failed to render PDF" }, { status: 500 });
  }
}
