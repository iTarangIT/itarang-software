/**
 * Category: injection — reflected XSS + SQL-error surface.
 *
 * Sends a unique HTML marker through query params and checks whether it comes
 * back UNESCAPED (reflected XSS), and sends a single quote to detect leaked SQL
 * errors (an injection/verbose-error surface). Non-mutating (GET only). Stored
 * XSS via form submission is mutating → deferred to aggressive mode.
 */
import type { Probe, ProbeContext } from "../probe-context";
import type { RawFinding } from "../types";
import { get } from "./util";
import { REFLECTED_PARAM_TARGETS } from "../crawl";

const TOKEN = "itxss7392";
const XSS_MARKER = `${TOKEN}"><img src=x onerror=${TOKEN}>`;
const RAW_NEEDLE = `<img src=x onerror=${TOKEN}>`;

const SQL_ERROR_RE =
  /syntax error at or near|unterminated quoted string|PostgresError|SQLSTATE|column .+ does not exist|invalid input syntax|neon|drizzle.*Failed query/i;

export const reflectedXssProbe: Probe = {
  slug: "reflected-xss",
  category: "injection",
  title: "Reflected XSS (unescaped parameter reflection)",
  description: "Injects an HTML marker via query params and checks for unescaped reflection in the response.",
  default_severity: "high",
  mutating: false,
  owasp_ref: "A03:2021",
  cwe_ref: "CWE-79",
  async run(ctx: ProbeContext): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    for (const t of REFLECTED_PARAM_TARGETS) {
      const path = `${t.path}?${t.param}=${encodeURIComponent(XSS_MARKER)}`;
      const f = await get(ctx.anon, ctx.baseUrl, path);
      if (f.status >= 400) continue;
      const reflectedRaw = f.body.includes(RAW_NEEDLE);
      const reflectedEscaped = f.body.includes(RAW_NEEDLE.replace(/</g, "&lt;"));
      if (reflectedRaw && !reflectedEscaped) {
        findings.push({
          check_slug: reflectedXssProbe.slug,
          category: "injection",
          severity: "high",
          confidence: "confirmed",
          title: `Reflected XSS via "${t.param}" at ${t.path}`,
          summary: `The "${t.param}" parameter is reflected into the response without HTML-encoding, so an attacker-supplied <img onerror> executes in the victim's browser.`,
          target_url: t.path,
          http_method: "GET",
          evidence: { param: t.param, marker: XSS_MARKER, status: f.status },
          reproduction: `GET ${ctx.baseUrl}${path} — the marker appears unescaped in the HTML.`,
          remediation: "HTML-encode all user input on output; prefer framework escaping and a strict CSP.",
          owasp_ref: "A03:2021",
          cwe_ref: "CWE-79",
        });
      }
    }
    return findings;
  },
};

export const sqlErrorProbe: Probe = {
  slug: "sql-error-leak",
  category: "injection",
  title: "Database error leaked from a query parameter",
  description: "Sends a single quote in query params and looks for leaked SQL/DB error strings.",
  default_severity: "medium",
  mutating: false,
  owasp_ref: "A03:2021",
  cwe_ref: "CWE-209",
  async run(ctx: ProbeContext): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    for (const t of REFLECTED_PARAM_TARGETS) {
      const path = `${t.path}?${t.param}=${encodeURIComponent("'\"))--")}`;
      const f = await get(ctx.anon, ctx.baseUrl, path);
      if (SQL_ERROR_RE.test(f.body)) {
        findings.push({
          check_slug: sqlErrorProbe.slug,
          category: "injection",
          severity: f.status >= 500 ? "high" : "medium",
          confidence: "likely",
          title: `SQL/DB error leaked via "${t.param}" at ${t.path}`,
          summary: `A crafted "${t.param}" value made the endpoint return a database error. Leaked DB errors reveal schema internals and often indicate an unsanitised query path (SQL injection surface).`,
          target_url: t.path,
          http_method: "GET",
          evidence: { param: t.param, status: f.status, errorSnippet: f.body.slice(0, 400) },
          reproduction: `GET ${ctx.baseUrl}${path} → response contains a DB error string.`,
          remediation: "Use parameterised queries (Drizzle does this — check raw sql`` interpolation) and never return raw DB errors to clients.",
          owasp_ref: "A03:2021",
          cwe_ref: "CWE-209",
        });
      }
    }
    return findings;
  },
};

const probes = [reflectedXssProbe, sqlErrorProbe];
export default probes;
