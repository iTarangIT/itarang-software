/**
 * Category: exposure — sensitive data readable without authentication.
 *
 * Reads a curated set of data/debug endpoints with NO cookies. Anything that
 * returns records unauthenticated is a finding; PII in the body escalates it.
 * Non-mutating.
 */
import type { Probe, ProbeContext } from "../probe-context";
import type { RawFinding, Severity } from "../types";
import { get, looksLikeData, detectPii } from "./util";
import { SENSITIVE_UNAUTH_ROUTES, DEBUG_ROUTES } from "../crawl";

export const unauthDataProbe: Probe = {
  slug: "unauth-data-exposure",
  category: "exposure",
  title: "Sensitive data readable without authentication",
  description: "Reads data endpoints with no session; flags any that return records, escalating on PII.",
  default_severity: "high",
  mutating: false,
  owasp_ref: "A01:2021",
  cwe_ref: "CWE-306",
  async run(ctx: ProbeContext): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    for (const t of SENSITIVE_UNAUTH_ROUTES) {
      const f = await get(ctx.anon, ctx.baseUrl, t.path);
      if (!looksLikeData(f)) continue;
      const pii = detectPii(f.body);
      const severity: Severity = pii.length ? "critical" : t.pii ? "high" : "medium";
      findings.push({
        check_slug: unauthDataProbe.slug,
        category: "exposure",
        severity,
        confidence: "confirmed",
        title: pii.length
          ? `Unauthenticated PII exposure at ${t.path}`
          : `Unauthenticated data exposure at ${t.path}`,
        summary: `${t.note} This endpoint returned records to a request with no session${
          pii.length ? `, including ${pii.join(", ")}.` : "."
        }`,
        target_url: t.path,
        http_method: "GET",
        evidence: { status: f.status, pii, bodySnippet: f.body.slice(0, 500) },
        reproduction: `curl -s ${ctx.baseUrl}${t.path} (no auth cookie) → ${f.status} with data.`,
        remediation:
          "Add a server-side auth/role check at the top of this route handler (middleware does not gate /api/*).",
        owasp_ref: "A01:2021",
        cwe_ref: pii.length ? "CWE-359" : "CWE-306",
      });
    }
    return findings;
  },
};

export const debugEndpointProbe: Probe = {
  slug: "debug-endpoint-exposed",
  category: "exposure",
  title: "Debug/test endpoint exposed",
  description: "Probes /api/debug/* and /api/test-* endpoints reachable without authentication.",
  default_severity: "high",
  mutating: false,
  owasp_ref: "A05:2021",
  cwe_ref: "CWE-489",
  async run(ctx: ProbeContext): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    for (const path of DEBUG_ROUTES) {
      const f = await get(ctx.anon, ctx.baseUrl, path);
      // 200/500 both indicate the handler ran unauthenticated; 404 = not present.
      if (f.status === 404 || f.status === 401 || f.status === 403) continue;
      if (f.status >= 300 && f.status < 400) continue; // redirected to login = gated
      findings.push({
        check_slug: debugEndpointProbe.slug,
        category: "exposure",
        severity: "high",
        confidence: f.status < 300 ? "confirmed" : "likely",
        title: `Debug/test endpoint reachable: ${path}`,
        summary: `The endpoint ${path} responded (HTTP ${f.status}) to an unauthenticated request. Debug/test endpoints can leak internals or perform privileged actions (some run DDL) and must not ship enabled.`,
        target_url: path,
        http_method: "GET",
        evidence: { status: f.status, bodySnippet: f.body.slice(0, 400) },
        reproduction: `curl -s ${ctx.baseUrl}${path} (no auth) → ${f.status}.`,
        remediation: "Delete these endpoints or gate them behind an admin check + a non-production guard.",
        owasp_ref: "A05:2021",
        cwe_ref: "CWE-489",
      });
    }
    return findings;
  },
};

const probes = [unauthDataProbe, debugEndpointProbe];
export default probes;
