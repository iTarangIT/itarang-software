// Zoho Invoice API client — handles refresh-token-based OAuth and the
// authenticated fetch wrapper. The Self Client in Zoho API Console gives us
// a long-lived refresh_token; we exchange it for short-lived access tokens
// in-process and cache until expiry.
//
// Required env vars (set in .env.local — see drizzle/E-105_*.sql header):
//   ZOHO_CLIENT_ID
//   ZOHO_CLIENT_SECRET
//   ZOHO_REFRESH_TOKEN     (generated once via the one-time curl in Phase 0)
//   ZOHO_ORGANIZATION_ID
//   ZOHO_REGION            ("in" or "com" — defaults to "in")

const ZOHO_REGION = process.env.ZOHO_REGION || "in";
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_ORGANIZATION_ID = process.env.ZOHO_ORGANIZATION_ID;

const ACCOUNTS_BASE = `https://accounts.zoho.${ZOHO_REGION}`;
const API_BASE = `https://www.zohoapis.${ZOHO_REGION}/invoice/v3`;

interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let cached: TokenCache | null = null;

function assertConfigured() {
  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN || !ZOHO_ORGANIZATION_ID) {
    throw new Error(
      "Zoho credentials missing. Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORGANIZATION_ID in .env.local.",
    );
  }
}

export async function getAccessToken(): Promise<string> {
  assertConfigured();
  const now = Date.now();
  if (cached && cached.expiresAt > now + 30_000) {
    return cached.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: ZOHO_CLIENT_ID!,
    client_secret: ZOHO_CLIENT_SECRET!,
    refresh_token: ZOHO_REFRESH_TOKEN!,
  });

  const res = await fetch(`${ACCOUNTS_BASE}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };

  if (!res.ok || !json.access_token) {
    throw new Error(
      `Zoho token refresh failed (${res.status}): ${json.error || JSON.stringify(json)}`,
    );
  }

  cached = {
    accessToken: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
  };
  return cached.accessToken;
}

export function getOrganizationId(): string {
  assertConfigured();
  return ZOHO_ORGANIZATION_ID!;
}

export async function zohoFetch(
  path: string,
  init: RequestInit & { query?: Record<string, string | number | undefined> } = {},
): Promise<Response> {
  const token = await getAccessToken();
  const url = new URL(`${API_BASE}${path}`);
  url.searchParams.set("organization_id", getOrganizationId());
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Zoho-oauthtoken ${token}`);

  const res = await fetch(url.toString(), { ...init, headers });
  // 304 Not Modified is a legitimate response to If-Modified-Since — callers
  // handle it explicitly. Don't treat it as an error.
  if (!res.ok && res.status !== 304) {
    const body = await res.text().catch(() => "");
    throw new Error(`Zoho API ${res.status} ${path}: ${body.slice(0, 500)}`);
  }
  return res;
}
