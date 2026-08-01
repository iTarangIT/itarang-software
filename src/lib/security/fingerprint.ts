/**
 * Who sent this request — everything about the attacker that the HTTP layer can
 * actually prove, assembled in one place.
 *
 * The event row's columns answer "what was sent" (path, query, rule). They do
 * not answer "who sent it, from where, with what", which is the first thing a
 * responder asks and the thing that decides whether a row is a bored scanner or
 * someone working on this specific CRM. That context lives here and is written
 * into `evidence` (jsonb — no migration needed).
 *
 * Edge-safe: reads only from `Headers`. No Node APIs, no DNS, no I/O, no
 * geo-database lookup — the geo values are the ones a CDN/proxy already put on
 * the request. Everything here is a few string tests on the hot path.
 *
 * Nothing in here is trusted blindly. Every value carries its provenance: the IP
 * says which header it came from, the geo block says which vendor set it, and a
 * client that *claims* to be a browser but doesn't behave like one is flagged
 * rather than believed.
 */
import { clientIp } from "./client-ip";

/** How the source address relates to us — a private/loopback source is our own
 *  proxy or health check, never an internet attacker. */
export type IpScope = "public" | "private" | "loopback" | "unknown";

/** What kind of software sent this, judged from the UA plus how it behaves. */
export type ClientKind = "browser" | "tool" | "scanner" | "bot" | "unknown";

export interface RequestFingerprint {
  /** Real client IP (proxy-written value, never the spoofable leftmost XFF entry). */
  ip: string | null;
  ipScope: IpScope;
  /** evidence.net — where the IP came from and what each hop claimed. */
  net: Record<string, unknown>;
  /** evidence.client — the sender's software and how it behaved. */
  client: Record<string, unknown>;
  /** evidence.geo — location as reported by the CDN/proxy, or null if none fronts us. */
  geo: Record<string, unknown> | null;
  /** evidence.request — what was addressed, in what shape. */
  request: Record<string, unknown>;
  /** Plain-language notes on why this sender looks automated or evasive. */
  flags: string[];
}

/**
 * Known attack tooling. Kept in sync with the scanner rule in ./detect.ts —
 * that one decides whether to block, this one only labels the sender, so a new
 * name added here is cosmetic and safe.
 */
const SCANNER_UA =
  /\b(sqlmap|nikto|nmap|masscan|acunetix|nessus|wpscan|dirbuster|gobuster|feroxbuster|havij|arachni|zgrab|nuclei|whatweb|openvas|hydra|metasploit|burp|zaproxy|w3af|joomscan|commix)\b/i;

/**
 * Generic HTTP clients. Not hostile by themselves — our own cron and the Bolna
 * webhook are in here — but a hit on an injection rule from one of these means
 * a script, not a person who clicked something.
 */
const TOOL_UA =
  /\b(curl|wget|python-requests|python-urllib|urllib3|go-http-client|okhttp|libwww-perl|lwp::|httpie|postmanruntime|insomnia|axios|node-fetch|got|undici|powershell|restsharp|guzzle|apache-httpclient|java\/|winhttp|scrapy|aiohttp)\b/i;

/** Well-behaved crawlers. Worth separating so a Googlebot hit isn't triaged as an attack. */
const BOT_UA =
  /\b(googlebot|bingbot|yandexbot|duckduckbot|baiduspider|ahrefsbot|semrushbot|mj12bot|dotbot|petalbot|applebot|facebookexternalhit|slackbot|twitterbot|discordbot|telegrambot|uptimerobot|pingdom|newrelicpinger|censys|shodan|internetmeasurement)\b/i;

/** Headers a CDN/proxy uses to hand us the client's location. */
const GEO_HEADERS: Array<[string, string]> = [
  // Cloudflare
  ["cf-ipcountry", "country"],
  ["cf-ipcity", "city"],
  ["cf-region", "region"],
  ["cf-iplongitude", "longitude"],
  ["cf-iplatitude", "latitude"],
  ["cf-ray", "cf_ray"],
  // Vercel
  ["x-vercel-ip-country", "country"],
  ["x-vercel-ip-city", "city"],
  ["x-vercel-ip-country-region", "region"],
  ["x-vercel-ip-latitude", "latitude"],
  ["x-vercel-ip-longitude", "longitude"],
  // Generic / other edges
  ["x-geoip-country", "country"],
  ["x-country-code", "country"],
  ["x-appengine-country", "country"],
  ["x-appengine-city", "city"],
];

/**
 * RFC1918 / loopback / link-local / CGNAT, v4 and v6.
 *
 * This matters beyond labelling: ./blocklist.ts refuses to ban anything that
 * isn't `public`. If nginx ever stops setting X-Real-IP, every request resolves
 * to the same loopback address, and an auto-ban on that address would take the
 * whole CRM offline for everyone at once.
 */
function ipScopeOf(ip: string | null): IpScope {
  if (!ip) return "unknown";
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::1" || v.startsWith("127.")) return "loopback";
  if (
    v.startsWith("10.") ||
    v.startsWith("192.168.") ||
    v.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(v) ||
    // 100.64.0.0/10 — carrier-grade NAT, i.e. still upstream of us.
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v) ||
    v.startsWith("fc") ||
    v.startsWith("fd") ||
    v.startsWith("fe80:")
  ) {
    return "private";
  }
  return /^[0-9a-f.:]+$/.test(v) ? "public" : "unknown";
}

export function isPublicIp(ip: string | null): boolean {
  return ipScopeOf(ip) === "public";
}

function classifyClient(ua: string): { kind: ClientKind; tool: string | null } {
  if (!ua) return { kind: "unknown", tool: null };
  const scanner = ua.match(SCANNER_UA);
  if (scanner) return { kind: "scanner", tool: scanner[0].toLowerCase() };
  const bot = ua.match(BOT_UA);
  if (bot) return { kind: "bot", tool: bot[0].toLowerCase() };
  const tool = ua.match(TOOL_UA);
  if (tool) return { kind: "tool", tool: tool[0].toLowerCase().replace(/\/$/, "") };
  if (/mozilla\/5\.0/i.test(ua)) return { kind: "browser", tool: null };
  return { kind: "unknown", tool: null };
}

/** Rough browser/OS read for the UI. Deliberately shallow — no UA-parsing dependency on the Edge hot path. */
function describeBrowser(ua: string): string | null {
  if (!/mozilla\/5\.0/i.test(ua)) return null;
  const browser =
    /\bedg\//i.test(ua) ? "Edge" :
    /\bopr\/|\bopera\b/i.test(ua) ? "Opera" :
    /\bchrome\//i.test(ua) ? "Chrome" :
    /\bfirefox\//i.test(ua) ? "Firefox" :
    /\bsafari\//i.test(ua) ? "Safari" :
    "Unknown browser";
  const os =
    /windows nt/i.test(ua) ? "Windows" :
    /android/i.test(ua) ? "Android" :
    /iphone|ipad|ios/i.test(ua) ? "iOS" :
    /mac os x/i.test(ua) ? "macOS" :
    /linux/i.test(ua) ? "Linux" :
    "unknown OS";
  return `${browser} on ${os}`;
}

export interface FingerprintContext {
  method: string;
  path: string;
  host: string;
  /** Raw query string including "?", or "". */
  search?: string;
  authenticated: boolean;
  userId?: string | null;
  role?: string | null;
}

/**
 * Build the full sender profile for one request.
 *
 * Costs a handful of header reads and regex tests — it is called only after a
 * rule has already fired, so benign traffic never pays for it.
 */
export function fingerprintRequest(headers: Headers, ctx: FingerprintContext): RequestFingerprint {
  const { ip, source: ipSource, chain, clientSuppliedForwardedFor } = clientIp(headers);
  const scope = ipScopeOf(ip);

  const ua = headers.get("user-agent") || "";
  const { kind, tool } = classifyClient(ua);
  const accept = headers.get("accept");
  const acceptLanguage = headers.get("accept-language");
  const acceptEncoding = headers.get("accept-encoding");
  const secFetchMode = headers.get("sec-fetch-mode");
  const secChUa = headers.get("sec-ch-ua");
  const hasCookies = headers.has("cookie");
  const authHeader = headers.get("authorization");

  const flags: string[] = [];
  if (!ua) flags.push("No User-Agent header — hand-rolled or deliberately stripped client.");
  if (kind === "scanner") flags.push(`Self-identifies as the attack tool "${tool}".`);
  if (kind === "tool") flags.push(`Scripted HTTP client (${tool}) — not a browser session.`);
  // A real browser always sends Accept-Language and (on Chromium) sec-ch-ua.
  // A UA string claiming to be a browser without them is a script wearing a
  // browser's name — the single most useful "this is deliberate" tell here.
  if (kind === "browser" && !acceptLanguage) {
    flags.push("Claims a browser User-Agent but sends no Accept-Language — automated client spoofing a browser.");
  }
  if (kind === "browser" && !secChUa && !secFetchMode) {
    flags.push("Browser User-Agent with no Sec-Fetch/Sec-CH headers — request was not made by a real browser navigation.");
  }
  if (!accept) flags.push("No Accept header — typical of raw scripted requests.");
  if (clientSuppliedForwardedFor) {
    flags.push("Client supplied its own X-Forwarded-For — an attempt to forge the source address, or a chained CDN. The recorded IP is the one our proxy wrote, not the client's claim.");
  }
  if (scope === "loopback" || scope === "private") {
    flags.push(`Source address is ${scope} — this came from inside the network (proxy, health check, or a missing X-Real-IP on nginx), not from the internet.`);
  }
  if (ctx.authenticated) {
    flags.push(`Request carried a valid session (${ctx.role ?? "unknown role"}) — this is an authenticated user, not an anonymous scanner.`);
  }
  if (authHeader) flags.push("Sent an Authorization header — API-style access attempt rather than the web UI.");

  const geo: Record<string, unknown> = {};
  for (const [header, key] of GEO_HEADERS) {
    const v = headers.get(header);
    // First vendor wins per key; also record which header supplied it so the
    // value is auditable rather than a bare "IN" with no origin.
    if (v && geo[key] === undefined) {
      geo[key] = v;
      geo[`${key}_source`] = header;
    }
  }

  return {
    ip,
    ipScope: scope,
    net: {
      ip_source: ipSource,
      ip_scope: scope,
      forwarded_chain: chain,
      client_supplied_xff: clientSuppliedForwardedFor,
      host: ctx.host,
      referer: headers.get("referer") || null,
      origin: headers.get("origin") || null,
    },
    client: {
      user_agent: ua || null,
      kind,
      tool,
      browser: describeBrowser(ua),
      accept,
      accept_language: acceptLanguage,
      accept_encoding: acceptEncoding,
      sec_ch_ua: secChUa,
      sec_fetch_mode: secFetchMode,
      sec_fetch_site: headers.get("sec-fetch-site"),
      has_cookies: hasCookies,
      has_authorization_header: !!authHeader,
      content_type: headers.get("content-type"),
      content_length: headers.get("content-length"),
    },
    geo: Object.keys(geo).length ? geo : null,
    request: {
      method: ctx.method,
      path: ctx.path,
      query: ctx.search || null,
      authenticated: ctx.authenticated,
      actor_user_id: ctx.userId ?? null,
      actor_role: ctx.role ?? null,
    },
    flags,
  };
}
