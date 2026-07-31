/**
 * Category: authz — broken access control / privilege escalation.
 *
 * Uses a low-privilege (dealer) session to reach admin-only surfaces. A dealer
 * who lands on an admin page (HTTP 200 instead of a redirect) or reads an
 * admin API has crossed a trust boundary. Non-mutating (reads only).
 */
import type { Probe, ProbeContext } from "../probe-context";
import type { RawFinding } from "../types";
import { get, looksLikeData } from "./util";
import { ADMIN_SURFACES } from "../crawl";

export const crossRoleAccessProbe: Probe = {
  slug: "cross-role-access",
  category: "authz",
  title: "Low-privilege role reaches admin surface",
  description: "Requests admin-only pages/APIs with a dealer session; flags any that are not redirected/denied.",
  default_severity: "high",
  mutating: false,
  owasp_ref: "A01:2021",
  cwe_ref: "CWE-285",
  async run(ctx: ProbeContext): Promise<RawFinding[]> {
    const dealer = ctx.api.get("dealer");
    if (!dealer) {
      ctx.log("cross-role-access: no dealer session — skipped");
      return [];
    }
    const findings: RawFinding[] = [];

    for (const s of ADMIN_SURFACES) {
      const f = await get(dealer, ctx.baseUrl, s.path);

      if (s.kind === "page") {
        // A correctly-gated page redirects a dealer (307/302) to their own
        // dashboard or /login. A 200 means the dealer rendered the admin page.
        if (f.status === 200 && !/\/login/i.test(f.headers["location"] ?? "")) {
          findings.push(mk(s.path, "page", f.status,
            `A dealer session received HTTP 200 for the admin page ${s.path} instead of being redirected. ${s.note}`));
        }
      } else {
        // API: a dealer must get 401/403. 200-with-data = broken access control.
        if (looksLikeData(f)) {
          findings.push(mk(s.path, "api", f.status,
            `A dealer session read the admin API ${s.path} (HTTP ${f.status}, data returned). ${s.note}`));
        }
      }
    }
    return findings;
  },
};

function mk(path: string, kind: string, status: number, summary: string): RawFinding {
  return {
    check_slug: crossRoleAccessProbe.slug,
    category: "authz",
    severity: "high",
    confidence: "confirmed",
    title: `Dealer can access admin ${kind}: ${path}`,
    summary,
    target_url: path,
    http_method: "GET",
    evidence: { status, role: "dealer" },
    reproduction: `Log in as a dealer, then request ${path} with that session → ${status}.`,
    remediation:
      "Enforce the required role in the route/page (requireRole/requireSalesHead); do not rely on client hiding. For /api/* remember middleware does not gate it.",
    owasp_ref: "A01:2021",
    cwe_ref: "CWE-285",
  };
}

const probes = [crossRoleAccessProbe];
export default probes;
