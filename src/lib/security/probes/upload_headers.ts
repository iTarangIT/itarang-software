/**
 * Category: upload_headers.
 *
 *   securityHeadersProbe — deterministic audit of response security headers and
 *     cookie flags (CSP / HSTS / X-Frame-Options / nosniff / Referrer-Policy,
 *     and Secure/HttpOnly/SameSite on Set-Cookie). Non-mutating; always runs.
 *
 *   unsafeUploadProbe — uploads a file whose bytes contradict its declared
 *     content-type to /api/uploads/dealer-documents. The route trusts the
 *     client-supplied file.type and does no magic-byte sniffing, so a spoofed
 *     type is stored. Mutating (writes to an isolated throwaway folder) →
 *     aggressive mode only.
 */
import type { Probe, ProbeContext } from "../probe-context";
import { abs } from "../probe-context";
import { rawGet } from "./util";
import type { RawFinding } from "../types";

const UPLOAD_ROUTE = "/api/uploads/dealer-documents";

export const securityHeadersProbe: Probe = {
  slug: "security-response-headers",
  category: "upload_headers",
  title: "Missing security response headers",
  description:
    "Audits the base response for CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy and cookie flags.",
  default_severity: "low",
  mutating: false,
  owasp_ref: "A05:2021",
  cwe_ref: "CWE-693",
  async run(ctx: ProbeContext): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const url = abs(ctx.baseUrl, "/login"); // public page, always reachable
    const res = await rawGet(ctx.anon, url);
    const headers = res.headers(); // lowercased single-value map
    const isHttps = ctx.baseUrl.startsWith("https://");

    const missing = (name: string) => !headers[name] || headers[name].trim() === "";

    if (missing("content-security-policy")) {
      findings.push(mk(url, "medium", "Content-Security-Policy header is not set", {
        title: "Missing Content-Security-Policy",
        summary:
          "Responses do not send a Content-Security-Policy. A CSP is the primary defence-in-depth control against injected/stored XSS executing in the browser.",
        remediation:
          "Set a Content-Security-Policy (at minimum a restrictive default-src and script-src) via next.config headers() or middleware.",
        cwe: "CWE-693",
      }));
    }

    if (missing("x-frame-options") && !(headers["content-security-policy"] ?? "").includes("frame-ancestors")) {
      findings.push(mk(url, "medium", "No clickjacking protection (X-Frame-Options / frame-ancestors)", {
        title: "Missing clickjacking protection",
        summary:
          "Neither X-Frame-Options nor a CSP frame-ancestors directive is present, so authenticated pages can be framed by a malicious site (clickjacking).",
        remediation: "Send X-Frame-Options: DENY (or a CSP frame-ancestors 'self').",
        cwe: "CWE-1021",
      }));
    }

    if (missing("x-content-type-options")) {
      findings.push(mk(url, "low", "X-Content-Type-Options: nosniff is not set", {
        title: "Missing X-Content-Type-Options",
        summary: "Without nosniff, browsers may MIME-sniff responses and treat uploaded/served content as an executable type.",
        remediation: "Send X-Content-Type-Options: nosniff on all responses.",
        cwe: "CWE-693",
      }));
    }

    if (missing("referrer-policy")) {
      findings.push(mk(url, "low", "Referrer-Policy is not set", {
        title: "Missing Referrer-Policy",
        summary: "No Referrer-Policy is set; full URLs (which may carry tokens/ids) can leak to third parties via the Referer header.",
        remediation: "Send Referrer-Policy: strict-origin-when-cross-origin (or stricter).",
        cwe: "CWE-200",
      }));
    }

    if (isHttps && missing("strict-transport-security")) {
      findings.push(mk(url, "medium", "HSTS (Strict-Transport-Security) is not set on an HTTPS host", {
        title: "Missing HSTS",
        summary: "The HTTPS host does not send Strict-Transport-Security, leaving users exposed to SSL-stripping on the first request.",
        remediation: "Send Strict-Transport-Security: max-age=31536000; includeSubDomains.",
        cwe: "CWE-319",
      }));
    }

    // Cookie flags — inspect every Set-Cookie on this response.
    const setCookies = res
      .headersArray()
      .filter((h) => h.name.toLowerCase() === "set-cookie");
    for (const c of setCookies) {
      const v = c.value;
      const name = v.split("=", 1)[0];
      const flags = v.toLowerCase();
      if (isHttps && !flags.includes("secure")) {
        findings.push(mk(url, "medium", `Cookie "${name}" set without Secure over HTTPS`, {
          title: `Cookie without Secure flag: ${name}`,
          summary: `The cookie "${name}" is set without the Secure attribute on an HTTPS host, so it can be sent over plaintext.`,
          remediation: "Set the Secure attribute on all cookies served over HTTPS.",
          cwe: "CWE-614",
        }));
      }
      if (!flags.includes("httponly")) {
        findings.push(mk(url, "low", `Cookie "${name}" set without HttpOnly`, {
          title: `Cookie without HttpOnly flag: ${name}`,
          summary: `The cookie "${name}" is readable from JavaScript (no HttpOnly), widening the impact of any XSS. Verify it is not a session/auth cookie.`,
          remediation: "Set HttpOnly on session/auth cookies.",
          cwe: "CWE-1004",
        }));
      }
    }

    return findings;
  },
};

export const unsafeUploadProbe: Probe = {
  slug: "upload-content-type-spoof",
  category: "upload_headers",
  title: "File upload accepts spoofed content-type",
  description:
    "Uploads a file whose bytes contradict its declared MIME type to the dealer-documents endpoint; the route does no magic-byte validation.",
  default_severity: "high",
  mutating: true,
  owasp_ref: "A04:2021",
  cwe_ref: "CWE-434",
  async run(ctx: ProbeContext): Promise<RawFinding[]> {
    if (ctx.mode !== "aggressive") return []; // writes an object — aggressive only
    const findings: RawFinding[] = [];
    const url = abs(ctx.baseUrl, UPLOAD_ROUTE);

    // A polyglot: declared image/png, but the bytes are an HTML/JS payload. A
    // route that sniffs magic bytes rejects this; one that trusts file.type stores it.
    const payload = Buffer.from('<html><script>/*itarang-security-scan*/</script></html>', "utf8");
    const res = await ctx.anon.post(url, {
      failOnStatusCode: false,
      multipart: {
        folder: "security-scan-throwaway",
        file: { name: "scan-probe.png", mimeType: "image/png", buffer: payload },
      },
    });
    const status = res.status();
    let body = "";
    try {
      body = (await res.text()).slice(0, 600);
    } catch {
      /* ignore */
    }
    const stored = status >= 200 && status < 300 && /url|path|key|http/i.test(body);
    if (stored) {
      findings.push({
        check_slug: unsafeUploadProbe.slug,
        category: "upload_headers",
        severity: "high",
        confidence: "confirmed",
        title: "Upload endpoint stores files with a spoofed content-type",
        summary:
          "A file declared as image/png but containing HTML/JS bytes was accepted and stored — the endpoint trusts the client-supplied MIME type and performs no magic-byte/content sniffing. Combined with the endpoint being unauthenticated and using the service-role key, this is a serious upload-security gap.",
        target_url: UPLOAD_ROUTE,
        http_method: "POST",
        evidence: { status, responseSnippet: body, uploadedAs: "image/png", realBytes: "text/html" },
        reproduction: `POST multipart to ${UPLOAD_ROUTE} with file.mimeType=image/png but HTML bytes; response ${status} returned a stored object reference.`,
        remediation:
          "Validate uploads by sniffing magic bytes (not file.type), enforce an allowlist server-side, and require authentication on the upload route.",
        owasp_ref: "A04:2021",
        cwe_ref: "CWE-434",
      });
    }
    return findings;
  },
};

function mk(
  url: string,
  severity: RawFinding["severity"],
  summaryShort: string,
  opts: { title: string; summary: string; remediation: string; cwe: string },
): RawFinding {
  return {
    check_slug: securityHeadersProbe.slug,
    category: "upload_headers",
    severity,
    confidence: "confirmed",
    title: opts.title,
    summary: opts.summary,
    target_url: "/login",
    http_method: "GET",
    evidence: { detail: summaryShort, checkedUrl: url },
    reproduction: `GET ${url} and inspect the response headers.`,
    remediation: opts.remediation,
    owasp_ref: "A05:2021",
    cwe_ref: opts.cwe,
  };
}

const probes = [securityHeadersProbe, unsafeUploadProbe];
export default probes;
