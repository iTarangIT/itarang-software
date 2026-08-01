/**
 * Resolve the real client IP behind the sandbox/production reverse proxy.
 *
 * Edge-safe: reads only from Headers, no Node APIs.
 *
 * WHY NOT `x-forwarded-for.split(",")[0]` — the previous approach:
 * nginx is configured with `$proxy_add_x_forwarded_for`, which APPENDS the true
 * peer to whatever the client already sent. So the LEFTMOST entry is attacker-
 * controlled: anyone can open a connection with `X-Forwarded-For: 1.2.3.4` and
 * every event we record blames 1.2.3.4. For an attack log that is worse than
 * useless — it lets the attacker frame an arbitrary address and hides their own.
 *
 * The trustworthy values are the ones OUR proxy wrote:
 *   - `x-real-ip`      — nginx sets it from $remote_addr (the actual TCP peer).
 *   - the RIGHTMOST `x-forwarded-for` entry — appended by our nginx, after any
 *     client-supplied entries.
 * `cf-connecting-ip` outranks both when Cloudflare fronts the app, because
 * Cloudflare overwrites rather than appends.
 *
 * The full chain is returned alongside so the UI can show what each hop claimed
 * — that is what makes a spoof attempt visible instead of silently trusted.
 */

export interface ClientIpResult {
  /** Best-effort real client IP, or null if no proxy header was present. */
  ip: string | null;
  /** Which header the value came from — shown in the UI so the value is auditable. */
  source: string | null;
  /** Raw header values, for forensics. Only keys that were actually present. */
  chain: Record<string, string>;
  /**
   * True when the client supplied its own x-forwarded-for entries ahead of the
   * proxy's. Not proof of spoofing (chained CDNs do this legitimately), but it
   * means the leftmost entry must not be trusted.
   */
  clientSuppliedForwardedFor: boolean;
}

const FORWARD_HEADERS = [
  "cf-connecting-ip",
  "true-client-ip",
  "x-real-ip",
  "x-forwarded-for",
  "x-client-ip",
] as const;

export function clientIp(headers: Headers): ClientIpResult {
  const chain: Record<string, string> = {};
  for (const h of FORWARD_HEADERS) {
    const v = headers.get(h);
    if (v) chain[h] = v;
  }

  const xffParts = (chain["x-forwarded-for"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Cloudflare / Akamai overwrite these, so they can't be spoofed through them.
  if (chain["cf-connecting-ip"]) return done(chain["cf-connecting-ip"], "cf-connecting-ip");
  if (chain["true-client-ip"]) return done(chain["true-client-ip"], "true-client-ip");
  // nginx: proxy_set_header X-Real-IP $remote_addr — the actual TCP peer.
  if (chain["x-real-ip"]) return done(chain["x-real-ip"], "x-real-ip");
  // Rightmost entry: the one our own proxy appended.
  if (xffParts.length) return done(xffParts[xffParts.length - 1], "x-forwarded-for (rightmost)");
  if (chain["x-client-ip"]) return done(chain["x-client-ip"], "x-client-ip");

  return { ip: null, source: null, chain, clientSuppliedForwardedFor: false };

  function done(ip: string, source: string): ClientIpResult {
    return { ip, source, chain, clientSuppliedForwardedFor: xffParts.length > 1 };
  }
}
