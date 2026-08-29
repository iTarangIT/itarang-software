/**
 * Runtime attack detection — the rules the middleware runs on every request.
 *
 * MUST stay Edge-safe: pure functions, no Node APIs, no DB, no imports that pull
 * the Node runtime (only the `Severity` *type*, which is erased at compile). It
 * runs in src/middleware.ts on the hot path, so every rule is a cheap regex or
 * Set lookup.
 *
 * Design bias: FEW FALSE POSITIVES. A rule that blocks (`action: "blocked"`)
 * fires only on payloads that essentially never appear in legitimate CRM
 * traffic. Softer signals (an unauthenticated hit on a sensitive endpoint, an
 * off-host redirect parameter) are `action: "logged"` — recorded, never blocked.
 *
 * This module sees ONE request at a time and therefore only catches attacks that
 * carry a payload. Volumetric and behavioural attacks — request floods, directory
 * enumeration, repeated auth attempts — have no payload to match; those live in
 * ./rate-watch.ts.
 */
import type { Severity } from "./severity";

export type ThreatType =
  | "sql_injection"
  | "xss"
  | "path_traversal"
  | "null_byte"
  | "scanner_ua"
  | "sensitive_unauth"
  | "command_injection"
  | "ssrf"
  | "lfi_rfi"
  | "jndi_injection"
  | "nosql_injection"
  | "crlf_injection"
  | "proto_pollution"
  | "xxe"
  | "open_redirect"
  | "sensitive_file_probe"
  | "method_abuse";

export interface ThreatSignal {
  event_type: ThreatType;
  severity: Severity;
  matched_rule: string;
  action: "blocked" | "logged";
  evidence: Record<string, unknown>;
}

export interface DetectInput {
  method: string;
  path: string;
  /** The raw query string including the leading "?", or "". */
  search: string;
  userAgent: string;
  hasSession: boolean;
  role?: string;
  /** Request host (`nextUrl.host`). Used to tell an in-app redirect from an off-site one. */
  host?: string;
}

// Known security scanners / attack tools. High confidence -> block.
const SCANNER_UA =
  /\b(sqlmap|nikto|nmap|masscan|acunetix|nessus|wpscan|dirbuster|gobuster|feroxbuster|havij|arachni|zgrab|nuclei|whatweb|openvas|hydra)\b/i;

// SQL injection - tight, high-signal phrases (avoids blocking a legit "select").
const SQLI =
  /(\bunion\s+select\b)|(\bor\s+1\s*=\s*1\b)|('(\s)*or(\s)*')|(';\s*(drop|delete|insert|update|alter)\s)|(\bsleep\s*\(\s*\d)|(\bbenchmark\s*\()|(\bpg_sleep\s*\()|(\binformation_schema\b)|(\bxp_cmdshell\b)|(\bunion\s+all\s+select\b)/i;

// Reflected XSS payload markers.
const XSS =
  /(<\s*script\b)|(on(error|load|mouseover|focus)\s*=)|(javascript\s*:)|(<\s*img[^>]+onerror)|(<\s*svg[^>]+onload)|(document\.cookie)/i;

// Directory traversal (raw and percent-encoded).
const TRAVERSAL = /(\.\.\/)|(\.\.\\)|(%2e%2e%2f)|(%2e%2e\/)|(\.\.%2f)|(\/etc\/passwd)|(\bboot\.ini\b)/i;

// Null byte injection: percent-encoded, the literal text "\x00", or a real NUL.
const NULL_BYTE = new RegExp("%00|\\\\x00|\\u0000");

// OS command injection: a shell metacharacter immediately followed by a real
// command. Requiring the command name is what keeps a stray ";" or "|" in a
// legitimate value (e.g. a pipe-separated filter) from matching.
const CMD_INJECTION =
  /(;\s*(?:cat|ls|id|whoami|uname|curl|wget|nc|bash|sh|python|perl)\s)|(\|\s*(?:nc|bash|sh|curl|wget|python)\s)|(\$\(\s*(?:id|whoami|cat|curl|wget|uname)\b)|(`\s*(?:id|whoami|cat|curl|wget|uname)\b)|(&&\s*(?:curl|wget|nc|bash|sh)\s)|(\/bin\/(?:ba|z|da)?sh\b)|(\bnc\s+-e\b)/i;

// SSRF: cloud metadata endpoints, loopback over an http(s) URL, and the exotic
// schemes that only ever appear in an SSRF payload. Bare "localhost" is
// deliberately NOT matched — it appears in legitimate dev redirect params.
const SSRF =
  /(169\.254\.169\.254)|(metadata\.google\.internal)|(\bhttps?:\/\/(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]|169\.254\.))|(\b(?:gopher|dict|ldap|ldaps):\/\/)|(\bfile:\/\/\/)/i;

// PHP/stream-wrapper file inclusion. None of these are meaningful to a Next.js
// app, which is exactly why their presence means someone is probing.
const LFI_RFI = /(php:\/\/(?:filter|input))|(data:\/\/text)|(expect:\/\/)|(zip:\/\/)|(phar:\/\/)/i;

// Log4Shell-style JNDI/expression lookups. Treated as CRITICAL: it is never
// ambiguous and it is the one payload worth waking someone up for.
const JNDI = /\$\{\s*(?:jndi|ldap|rmi|dns|env|sys|lower|upper)\s*:/i;

// NoSQL / query-operator injection.
const NOSQL =
  /(\[\s*\$(?:ne|gt|gte|lt|lte|in|nin|regex|where|exists|or|and)\s*\])|("\$(?:where|ne|gt|gte|lt|lte|regex|exists|in|nin)"\s*:)|(\$where\s*:)/i;

// CRLF / response-splitting. Tested against the RAW (still-encoded) URL only —
// a decoded "\r\n" appears legitimately inside JSON bodies (textareas), so
// matching the decoded form would generate constant false positives.
const CRLF = /%0d%0a|%0a%0d|%0d%0d%0a/i;

// Prototype pollution.
const PROTO_POLLUTION = /(__proto__)|(constructor\s*\[\s*["']?prototype)|(\bprototype\s*\[)/i;

// XML external entity.
const XXE = /(<!ENTITY\b)|(<!DOCTYPE[^>]{0,200}\bSYSTEM\b)|(SYSTEM\s+["']file:)/i;

// Files and admin panels that do not exist in this app. A request for one is a
// scanner walking a wordlist — unambiguous, so it blocks.
const SENSITIVE_FILE_PROBE =
  /(^|\/)(\.env(\.|$)|\.git\/|\.svn\/|\.hg\/|\.aws\/|\.ssh\/|id_rsa\b|\.DS_Store|\.htaccess|web\.config|wp-admin|wp-login\.php|xmlrpc\.php|phpmyadmin|phpinfo\.php|vendor\/phpunit|actuator(\/|$)|server-status|dump\.sql|database\.sql)|\.(bak|old|swp|sql\.gz)$/i;

// HTTP methods with no legitimate use here. TRACE/TRACK enable cross-site
// tracing; CONNECT is a proxy request.
const ABUSED_METHODS = new Set(["TRACE", "TRACK", "CONNECT"]);

// Query params whose value is used as a redirect destination.
const REDIRECT_PARAMS = new Set([
  "next",
  "redirect",
  "redirect_uri",
  "redirect_url",
  "redirect_to",
  "return",
  "returnurl",
  "returnto",
  "continue",
  "url",
  "dest",
  "destination",
  "target",
  "goto",
  "callback",
]);

// Endpoints that expose data and should never be hit unauthenticated. A live
// unauthenticated hit here is a strong "someone is probing" signal (logged, not
// blocked - the fix is to gate the route, not to 403 in middleware).
const SENSITIVE_PREFIXES = [
  "/api/dealer-onboarding/list",
  "/api/scraper-leads",
  "/api/debug/",
  "/api/kyc/",
  "/api/coborrower/",
  "/api/leads/",
];

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Off-host redirect detection. Only flags when the destination resolves to a
 * DIFFERENT host than the one serving the request — otherwise every legitimate
 * OAuth/`?next=` round-trip would be reported.
 */
function detectOpenRedirect(search: string, host?: string): ThreatSignal | null {
  if (!search || !host) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  } catch {
    return null;
  }
  for (const [key, value] of params) {
    if (!REDIRECT_PARAMS.has(key.toLowerCase())) continue;
    const v = safeDecode(value).trim();
    // Protocol-relative ("//evil.com") or absolute ("https://evil.com").
    const isProtocolRelative = /^\/\/[^/]/.test(v);
    const isAbsolute = /^https?:\/\//i.test(v);
    if (!isProtocolRelative && !isAbsolute) continue;
    let targetHost: string;
    try {
      targetHost = new URL(isProtocolRelative ? `https:${v}` : v).host;
    } catch {
      continue;
    }
    if (targetHost && targetHost.toLowerCase() !== host.toLowerCase()) {
      return {
        event_type: "open_redirect",
        severity: "low",
        matched_rule: "open-redirect",
        action: "logged",
        evidence: { param: key, target: targetHost, value: v.slice(0, 300) },
      };
    }
  }
  return null;
}

/**
 * Inspect one request. Returns the single highest-priority threat signal, or
 * null if the request looks benign. Order matters - the most severe/certain
 * rules are checked first and returned immediately.
 */
export function detectThreat(input: DetectInput): ThreatSignal | null {
  const ua = input.userAgent || "";
  // Test both the raw and decoded query so percent-encoded payloads are caught.
  // Also normalise "+" to a space: form-encoding (and curl --data-urlencode)
  // sends spaces as "+", which decodeURIComponent leaves intact — so "OR+1=1"
  // would otherwise slip past a rule expecting whitespace.
  const raw = input.search || "";
  const decoded = safeDecode(raw).replace(/\+/g, " ");
  const hay = `${input.path} ${raw} ${decoded}`;

  // 1. JNDI / Log4Shell - unambiguous and severe enough to alert immediately.
  if (JNDI.test(decoded) || JNDI.test(raw)) {
    return block("jndi_injection", "critical", "jndi-lookup", { matched: snippet(decoded) });
  }

  // 2. Scanner user-agent - unambiguous tooling.
  if (SCANNER_UA.test(ua)) {
    const tool = ua.match(SCANNER_UA)?.[0] ?? "scanner";
    return block("scanner_ua", "high", `scanner-ua:${tool.toLowerCase()}`, { userAgent: ua.slice(0, 200) });
  }

  // 3. Abused HTTP method.
  if (ABUSED_METHODS.has((input.method || "").toUpperCase())) {
    return block("method_abuse", "medium", `method:${input.method.toLowerCase()}`, { method: input.method });
  }

  // 4. Null byte.
  if (NULL_BYTE.test(hay)) {
    return block("null_byte", "high", "null-byte", { matched: snippet(hay) });
  }

  // 5. Path traversal.
  if (TRAVERSAL.test(hay)) {
    return block("path_traversal", "high", "path-traversal", { matched: snippet(hay) });
  }

  // 6. Probing for files/panels this app does not have.
  if (SENSITIVE_FILE_PROBE.test(input.path)) {
    return block("sensitive_file_probe", "high", "sensitive-file-probe", { path: input.path });
  }

  // 7. SQL injection.
  if (SQLI.test(decoded) || SQLI.test(raw)) {
    return block("sql_injection", "high", "sqli-pattern", { matched: snippet(decoded) });
  }

  // 8. Reflected XSS payload.
  if (XSS.test(decoded) || XSS.test(raw)) {
    return block("xss", "high", "xss-pattern", { matched: snippet(decoded) });
  }

  // 9. OS command injection.
  if (CMD_INJECTION.test(decoded) || CMD_INJECTION.test(raw)) {
    return block("command_injection", "high", "command-injection", { matched: snippet(decoded) });
  }

  // 10. SSRF.
  if (SSRF.test(decoded) || SSRF.test(raw)) {
    return block("ssrf", "high", "ssrf-target", { matched: snippet(decoded) });
  }

  // 11. Stream-wrapper file inclusion.
  if (LFI_RFI.test(decoded) || LFI_RFI.test(raw)) {
    return block("lfi_rfi", "high", "file-inclusion", { matched: snippet(decoded) });
  }

  // 12. XXE.
  if (XXE.test(decoded)) {
    return block("xxe", "high", "xxe-entity", { matched: snippet(decoded) });
  }

  // 13. NoSQL / query-operator injection.
  if (NOSQL.test(decoded) || NOSQL.test(raw)) {
    return block("nosql_injection", "high", "nosql-operator", { matched: snippet(decoded) });
  }

  // 14. CRLF / response splitting (raw form only — see the CRLF const).
  if (CRLF.test(raw) || CRLF.test(input.path)) {
    return block("crlf_injection", "high", "crlf-injection", { matched: snippet(raw) });
  }

  // 15. Prototype pollution.
  if (PROTO_POLLUTION.test(decoded) || PROTO_POLLUTION.test(raw)) {
    return block("proto_pollution", "high", "proto-pollution", { matched: snippet(decoded) });
  }

  // 16. Off-host redirect parameter — logged, never blocked (see the helper).
  const redirect = detectOpenRedirect(raw, input.host);
  if (redirect) return redirect;

  // 17. Unauthenticated hit on a sensitive endpoint - log, do not block.
  if (!input.hasSession && SENSITIVE_PREFIXES.some((p) => input.path.startsWith(p))) {
    return {
      event_type: "sensitive_unauth",
      severity: "medium",
      matched_rule: "sensitive-unauth",
      action: "logged",
      evidence: { path: input.path, note: "No session on a sensitive endpoint." },
    };
  }

  return null;
}

/**
 * Inspect a request BODY (POST/PUT/PATCH) for the same injection payloads. Used
 * by the middleware only when SECURITY_INSPECT_BODY=1, on a cloned request so
 * the original body still reaches the route.
 *
 * Deliberately narrower than the URL rules: traversal, CRLF, open-redirect and
 * file-probe are URL/path concerns, and matching CRLF or traversal inside a JSON
 * text field (an address, a note) would fire constantly on real CRM traffic.
 */
export function detectBodyThreat(body: string): ThreatSignal | null {
  if (!body) return null;
  const b = body.replace(/\+/g, " ");
  if (JNDI.test(b)) return block("jndi_injection", "critical", "jndi-lookup-body", { matched: snippet(b) });
  if (NULL_BYTE.test(body)) return block("null_byte", "high", "null-byte-body", { matched: snippet(body) });
  if (SQLI.test(b)) return block("sql_injection", "high", "sqli-body", { matched: snippet(b) });
  if (XSS.test(b)) return block("xss", "high", "xss-body", { matched: snippet(b) });
  if (CMD_INJECTION.test(b)) return block("command_injection", "high", "command-injection-body", { matched: snippet(b) });
  if (LFI_RFI.test(b)) return block("lfi_rfi", "high", "file-inclusion-body", { matched: snippet(b) });
  if (XXE.test(b)) return block("xxe", "high", "xxe-entity-body", { matched: snippet(b) });
  if (NOSQL.test(b)) return block("nosql_injection", "high", "nosql-operator-body", { matched: snippet(b) });
  if (PROTO_POLLUTION.test(b)) return block("proto_pollution", "high", "proto-pollution-body", { matched: snippet(b) });
  if (SSRF.test(b)) return block("ssrf", "high", "ssrf-target-body", { matched: snippet(b) });
  return null;
}

function block(
  event_type: ThreatType,
  severity: Severity,
  matched_rule: string,
  evidence: Record<string, unknown>,
): ThreatSignal {
  return { event_type, severity, matched_rule, action: "blocked", evidence };
}

function snippet(s: string): string {
  return s.slice(0, 300);
}
