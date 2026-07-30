/**
 * Category: authz — IDOR (insecure direct object reference).
 *
 * Harvests a REAL record id, then reads ID-scoped routes (KYC / co-borrower /
 * onboarding) both unauthenticated and as a dealer who does not own the record.
 * A specific record returned to a party that shouldn't see it is a confirmed
 * ownership-check failure. Non-mutating.
 */
import type { Probe, ProbeContext } from "../probe-context";
import type { RawFinding, Severity } from "../types";
import { get, looksLikeData, detectPii, harvestId } from "./util";
import { idScopedRoutes } from "../crawl";

export const idorProbe: Probe = {
  slug: "idor-object-reference",
  category: "authz",
  title: "ID-scoped record readable without ownership",
  description: "Reads ID-scoped KYC/co-borrower/onboarding routes as anon and as a non-owner dealer.",
  default_severity: "high",
  mutating: false,
  owasp_ref: "A01:2021",
  cwe_ref: "CWE-639",
  async run(ctx: ProbeContext): Promise<RawFinding[]> {
    const id = await harvestId(ctx);
    if (!id) {
      ctx.log("idor: no record id could be harvested — skipped");
      return [];
    }
    const findings: RawFinding[] = [];
    const dealer = ctx.api.get("dealer");

    for (const path of idScopedRoutes(id)) {
      // 1) Unauthenticated read — the strongest signal.
      const anon = await get(ctx.anon, ctx.baseUrl, path);
      if (looksLikeData(anon)) {
        const pii = detectPii(anon.body);
        findings.push(finding(path, "anonymous", anon.status, pii,
          `${path} returned record ${id} to a request with no session.`));
        continue; // already worst-case; no need to also test the dealer
      }
      // 2) Authenticated but non-owner read.
      if (dealer) {
        const asDealer = await get(dealer, ctx.baseUrl, path);
        if (looksLikeData(asDealer)) {
          const pii = detectPii(asDealer.body);
          findings.push(finding(path, "non-owner dealer", asDealer.status, pii,
            `${path} returned record ${id} to a dealer session that may not own it (no ownership check evident).`));
        }
      }
    }
    return findings;
  },
};

function finding(path: string, who: string, status: number, pii: string[], summary: string): RawFinding {
  const severity: Severity = pii.length ? "critical" : "high";
  const confidence = who === "anonymous" ? "confirmed" : "likely";
  return {
    check_slug: idorProbe.slug,
    category: "authz",
    severity,
    confidence,
    title: `IDOR: ${path} readable by ${who}`,
    summary: summary + (pii.length ? ` Body contained ${pii.join(", ")}.` : ""),
    target_url: path,
    http_method: "GET",
    evidence: { status, accessedBy: who, pii },
    reproduction: `Obtain a real record id, then GET ${path} as ${who} → ${status} with data.`,
    remediation:
      "Enforce ownership on every ID-scoped route: verify the record belongs to the authenticated principal (tenant/dealer/lead owner) before returning it.",
    owasp_ref: "A01:2021",
    cwe_ref: "CWE-639",
  };
}

const probes = [idorProbe];
export default probes;
