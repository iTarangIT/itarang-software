/**
 * The business-designed digest layout — Sales Daily, from the "Daily Sales
 * email · Block A" design (docs/crm-reports-admin/CRM Reporting &
 * Dashboards.html, desktop + phone frames).
 *
 *   header card   title · audience · "Data updated till …"
 *   intro         eyebrow, the covered day, what MTD and targets mean
 *   headline      "Yesterday: …" / "Month to date: …", label in bold
 *   blocks        bordered grids: group bands in the accent colour, a note
 *                 under each metric, "% of target" as a red / amber / green
 *                 pill, Δ green when up and red when down, "Right now" box
 *                 and the legend after the block that carries them
 *   footer        button, link, attachment line, who sends it
 *
 * Email clients drop flexbox and CSS grid, so the design's grids are rebuilt
 * as tables with inline styles. The phone frame (YDAY · MTD with Δ under it ·
 * TARGET) comes from one media query: columns not in `phoneColumns` hide below
 * 600 px, and the Δ under MTD only shows there. Gmail, Apple Mail and Outlook
 * mobile honour it; a client that ignores it shows the full table.
 *
 * Pure: strings in, string out — buildDigestEmail calls it and a test can
 * render it without a mailer.
 */
import type { DigestFigures, DigestMasthead, DigestTable } from "@/lib/digests/types";
import { RAG_CELL_STYLE, ragToneOfCell } from "@/lib/digests/rag";

const ACCENT = "#1D4ED8";
const INK = "#0F172A";
const TEXT = "#111827";
const BODY = "#374151";
const SOFT = "#4B5563";
const MUTE = "#6B7280";
const FAINT = "#9CA3AF";
const LINE = "#E5E7EB";
const HAIR = "#F1F3F6";
const HEAD_BG = "#F8FAFC";
const FONT = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";

function esc(v: unknown): string {
  const s = v == null ? "" : String(v);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** "Yesterday: 2 converted …" → <b>Yesterday:</b> 2 converted … */
function boldLead(s: string): string {
  const i = s.indexOf(":");
  if (i < 0 || i > 40) return esc(s);
  return `<span style="font-weight:700">${esc(s.slice(0, i + 1))}</span>${esc(s.slice(i + 1))}`;
}

/** "+18%" green, "−9%" red, anything else muted. */
function deltaColor(v: string | number): string {
  const s = String(v).trim();
  if (/^\+\d/.test(s)) return "#15803D";
  if (/^[−-]\d/.test(s)) return "#B91C1C";
  if (/^0%$/.test(s)) return BODY;
  return FAINT;
}

const isMuted = (v: string | number) => v === "—" || v === "n/t" || v === "new" || v === "";

function cellText(v: string | number, extra = ""): string {
  const color = v === "Not measured yet" || isMuted(v) ? FAINT : BODY;
  return `<span style="color:${color};${extra}">${esc(v)}</span>`;
}

function renderTable(t: DigestTable, on: (k: string) => boolean, hint?: string): string {
  const textCols = t.textColumns ?? 2;
  const phone = t.phoneColumns ? new Set(t.phoneColumns) : null;
  const cls = (i: number) => (phone && !phone.has(i) ? ` class="sd-desk"` : "");
  const tone = new Set(t.toneColumns ?? []);
  const delta = new Set(t.deltaColumns ?? []);
  const strong = t.strongColumn;
  const deltaUnder = t.phoneDeltaUnder;
  const isGroup = (r: Array<string | number>) => !!t.groupHeaders && r.slice(1).every((v) => v === "" || v == null);

  // Many-column blocks (B, C) get tighter cells so they fit an 880 px card.
  const dense = t.columns.length > 9;
  const pad = dense ? "4px" : "6px";
  const size = dense ? "12.5px" : "13.5px";
  // Block A's metric column is fixed (design: 212 px) so its notes wrap under
  // the name; elsewhere the name column just never wraps.
  const firstCol = t.rowNotes ? "width:212px;" : "white-space:nowrap;";
  const head = t.columns
    .map(
      (c, i) =>
        `<th${cls(i)} style="${i === 0 ? firstCol : ""}padding:10px ${i === 0 ? "12px" : pad};text-align:${i < textCols ? "left" : "right"};` +
        `font-size:${dense ? "10px" : "11px"};font-weight:700;letter-spacing:.04em;text-transform:uppercase;` +
        `color:${i === strong ? INK : "#475569"};background:${HEAD_BG};border-bottom:1px solid ${LINE};vertical-align:bottom">${esc(c)}</th>`,
    )
    .join("");

  const body = t.rows
    .map((r, ri) => {
      if (isGroup(r)) {
        return `<tr><td colspan="${t.columns.length}" style="padding:10px 12px 5px;border-top:1px solid ${LINE};` +
          `font-size:11px;font-weight:700;letter-spacing:.08em;color:${ACCENT}">${esc(r[0])}</td></tr>`;
      }
      const note = t.rowNotes?.[ri];
      const cells = r
        .map((v, i) => {
          const base = `padding:8px ${i === 0 ? "12px" : pad};border-top:1px solid ${HAIR};` +
            `text-align:${i < textCols ? "left" : "right"};vertical-align:middle;font-size:${size};`;
          if (i === 0) {
            return `<td style="${base}${firstCol}"><div style="font-weight:600;color:${TEXT}">${esc(v)}</div>` +
              (note ? `<div class="sd-desk" style="font-size:11.5px;color:${MUTE};margin-top:2px">${esc(note)}</div>` : "") +
              `</td>`;
          }
          if (tone.has(i)) {
            const tn = ragToneOfCell(v);
            const pill = tn
              ? `<span style="display:inline-block;font-size:12.5px;font-weight:700;border-radius:999px;padding:3px 9px;` +
                `background:${RAG_CELL_STYLE[tn].background};color:${RAG_CELL_STYLE[tn].color}">${esc(v)}</span>`
              : cellText(v);
            return `<td${cls(i)} style="${base}white-space:nowrap">${pill}</td>`;
          }
          if (delta.has(i)) {
            return `<td${cls(i)} style="${base}white-space:nowrap;font-weight:600;color:${deltaColor(v)}">${esc(v)}</td>`;
          }
          const under =
            deltaUnder && deltaUnder[1] === i && !isMuted(r[deltaUnder[0]])
              ? `<div class="sd-mob" style="display:none;font-size:11px;font-weight:600;color:${deltaColor(r[deltaUnder[0]])}">${esc(r[deltaUnder[0]])}</div>`
              : "";
          const weight = i === strong ? "font-weight:700;color:" + INK + ";" : "";
          return `<td${cls(i)} style="${base}white-space:nowrap;font-variant-numeric:tabular-nums">` +
            (weight ? `<span style="${weight}">${esc(v)}</span>` : cellText(v)) + under + `</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  const grid = t.rows.length
    ? `<div style="overflow-x:auto"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate;border-spacing:0;` +
      `width:100%;border:1px solid ${LINE};border-radius:10px;overflow:hidden;font-family:${FONT}">` +
      `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
    : `<p style="margin:0;padding:12px 14px;border:1px solid ${LINE};border-radius:10px;color:${MUTE};font-size:13px">${esc(t.empty ?? "Nothing to show.")}</p>`;

  const footer =
    t.footer && on(t.footer.key)
      ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;width:100%;` +
        `margin-top:16px;background:#F1F5F9;border-radius:10px;font-family:${FONT}">` +
        `<tr><td colspan="${t.footer.items.length}" style="padding:14px 16px 4px;font-size:11px;font-weight:700;letter-spacing:.08em;` +
        `color:#475569;text-transform:uppercase">${esc(t.footer.label)}</td></tr><tr>` +
        t.footer.items
          .map(
            (it) =>
              `<td class="sd-stack" valign="top" style="padding:6px 16px 14px;vertical-align:top;width:${Math.floor(100 / t.footer!.items.length)}%">` +
              `<div style="font-size:13px;color:${SOFT}">${esc(it.label)}</div>` +
              `<div style="font-size:20px;font-weight:700;color:${INK};margin:3px 0">${esc(it.value)}</div>` +
              (it.hint
                ? `<div style="font-size:12px;${it.alert ? "color:#B91C1C;font-weight:600" : `color:${MUTE}`}">${esc(it.hint)}</div>`
                : "") +
              `</td>`,
          )
          .join("") +
        `</tr></table>`
      : "";

  const legend = t.legend?.length
    ? `<div style="margin-top:14px;font-size:12px;line-height:1.5;color:${MUTE}">` +
      t.legend.map((l) => `<div>${boldLead(l)}</div>`).join("") +
      `</div>`
    : "";

  const note = t.note ? `<p style="margin:0 0 10px;font-size:12.5px;line-height:1.5;color:${MUTE}">${esc(t.note)}</p>` : "";

  return `
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;width:100%;margin:22px 0 10px;font-family:${FONT}">
    <tr><td style="font-size:17px;font-weight:700;color:${INK}">${esc(t.title)}</td>
    ${hint ? `<td class="sd-desk" align="right" style="font-size:12px;color:${MUTE}">${hint}</td>` : ""}</tr></table>
  ${note}${grid}${footer}${legend}`;
}

export function renderMastheadHtml(args: {
  figures: DigestFigures & { masthead: DigestMasthead };
  tables: DigestTable[];
  headline: string[];
  on: (key: string) => boolean;
  isTest: boolean;
  ctaHref: string;
  ctaLabel: string;
  attachmentLine: string | null;
}): string {
  const m = args.figures.masthead;
  const testPill = args.isTest
    ? `<span style="display:inline-block;font-size:11px;font-weight:600;color:#92400E;background:#FEF3C7;border-radius:999px;padding:3px 9px;margin-left:8px;vertical-align:middle">Test send</span>`
    : "";
  const headline = args.headline.length
    ? `<div style="margin:18px 0 0;padding:14px 16px;background:${HEAD_BG};border:1px solid ${LINE};border-radius:10px;` +
      `font-size:14px;line-height:1.55;color:${TEXT}">${args.headline.map(boldLead).join(" ")}</div>`
    : "";
  const blocks = args.tables
    .map((t, i) =>
      renderTable(
        t,
        args.on,
        i === 0 && m.firstBlockHint
          ? `<a href="${esc(args.ctaHref)}" style="color:${ACCENT};text-decoration:none">${esc(m.firstBlockHint)}</a>`
          : undefined,
      ),
    )
    .join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
@media only screen and (max-width:600px){
  .sd-outer{padding:0!important}
  .sd-card{border-radius:0!important;border-left:0!important;border-right:0!important}
  .sd-pad{padding-left:16px!important;padding-right:16px!important}
  .sd-desk{display:none!important}
  .sd-mob{display:block!important}
  .sd-stack{display:block!important;width:auto!important}
  .sd-h1{font-size:17px!important}
}
</style></head>
<body style="margin:0;background:#EEF0F3">
<div class="sd-outer" style="padding:24px 12px;background:#EEF0F3;font-family:${FONT};color:${INK}">
<div class="sd-card" style="max-width:880px;margin:0 auto;background:#FFFFFF;border:1px solid ${LINE};border-radius:12px;overflow:hidden">

  <div class="sd-pad" style="padding:20px 28px 18px;border-bottom:1px solid ${LINE}">
    <div class="sd-h1" style="font-size:20px;font-weight:700;letter-spacing:-.01em;color:${INK}">${esc(m.title)}${testPill}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;width:100%;margin-top:8px;font-family:${FONT}">
      <tr>
        <td class="sd-stack" style="font-size:13px;color:${SOFT}"><span style="font-weight:600;color:${TEXT}">${esc(m.audience.split(" to ")[0])}</span>${m.audience.includes(" to ") ? ` to ${esc(m.audience.split(" to ").slice(1).join(" to "))}` : ""}</td>
        <td class="sd-stack" align="right" style="font-size:13px;color:${SOFT};white-space:nowrap">
          Data updated till <span style="font-weight:700;color:${TEXT}">${esc(m.dataAsOf)}</span></td>
      </tr>
    </table>
  </div>

  <div class="sd-pad" style="padding:26px 28px 28px">
    <div style="font-size:11px;font-weight:700;letter-spacing:.1em;color:${ACCENT}">${esc(m.eyebrow)}</div>
    <div style="font-size:24px;font-weight:700;letter-spacing:-.01em;margin:6px 0">${esc(m.dayHeading)}</div>
    <p style="margin:0;font-size:13.5px;line-height:1.5;color:${SOFT}">${esc(m.intro)}</p>
    ${headline}
    ${blocks}
    <p style="margin:26px 0 8px">
      <a href="${esc(args.ctaHref)}" style="background:${ACCENT};color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block;font-size:14px">${esc(args.ctaLabel)}</a>
    </p>
    <p style="margin:0 0 6px;font-size:12px;color:${FAINT}">If the button doesn't work, paste this link into your browser:<br>${esc(args.ctaHref)}</p>
    ${args.attachmentLine ? `<p style="margin:0;font-size:12px;color:${FAINT}">${args.attachmentLine}</p>` : ""}
  </div>

  <div class="sd-pad" style="padding:14px 28px;border-top:1px solid ${LINE};font-size:11.5px;color:${FAINT}">${esc(m.footer)}</div>
</div>
</div>
</body></html>`;
}
