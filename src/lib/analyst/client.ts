import "server-only";

// Data Analyst agent — the one place the CRM talks to the agent.
//
// The agent (github.com/iTarangIT/Data-Analysis-Agent-Main) is a separate FastAPI service that
// verifies Supabase access tokens against ITS OWN Supabase project's JWKS. A CRM session comes
// from a different project (judnrwuiwkevkvvntrau), so passing the user's token through is
// refused ("Unable to find a signing key"). Instead the CRM signs in to the agent's project as
// one service account and calls the agent on its behalf:
//
//   browser ──(CRM session)──► /api/analyst/*  role gate (ceo / sales_head / admin)
//                                     │  service account's bearer token
//                                     ▼
//                             agent  (ANALYST_API_URL)
//
// Every CRM user therefore shares one agent tenant — its connections, budget and run history.
// Conversations are kept apart by prefixing each thread id with the CRM user's id
// (src/lib/analyst/access.ts); the routes refuse to read or continue anyone else's thread.
//
// The token never leaves the server: this module is server-only and nothing it returns carries
// the Authorization header onward.

import { AnalystError, normalizeAgentError } from "./errors";

type Config = {
  apiUrl: string;
  supabaseUrl: string;
  supabaseKey: string;
  email: string;
  password: string;
  timeoutMs: number;
};

function config(): Config {
  const apiUrl = process.env.ANALYST_API_URL?.trim().replace(/\/+$/, "");
  const supabaseUrl = process.env.ANALYST_SUPABASE_URL?.trim().replace(/\/+$/, "");
  const supabaseKey = process.env.ANALYST_SUPABASE_KEY?.trim();
  const email = process.env.ANALYST_SERVICE_EMAIL?.trim();
  const password = process.env.ANALYST_SERVICE_PASSWORD;

  const missing = [
    !apiUrl && "ANALYST_API_URL",
    !supabaseUrl && "ANALYST_SUPABASE_URL",
    !supabaseKey && "ANALYST_SUPABASE_KEY",
    !email && "ANALYST_SERVICE_EMAIL",
    !password && "ANALYST_SERVICE_PASSWORD",
  ].filter(Boolean);
  if (missing.length) {
    throw new AnalystError(
      `the analyst is not configured on this server (missing ${missing.join(", ")})`,
      503,
      "not_configured",
    );
  }

  const timeoutMs = Number(process.env.ANALYST_API_TIMEOUT_MS) || 15_000;
  return { apiUrl: apiUrl!, supabaseUrl: supabaseUrl!, supabaseKey: supabaseKey!, email: email!, password: password!, timeoutMs };
}

export function analystConfigured(): boolean {
  try {
    config();
    return true;
  } catch {
    return false;
  }
}

// ── Service-account token ─────────────────────────────────────────────────────

type Token = { access: string; refresh: string; expiresAt: number };

let token: Token | null = null;
let pending: Promise<Token> | null = null;

/** Refresh this long before expiry, so a token never lapses mid-request. */
const EXPIRY_MARGIN_MS = 60_000;

async function grant(cfg: Config, body: Record<string, string>, type: "password" | "refresh_token"): Promise<Token> {
  const response = await fetch(`${cfg.supabaseUrl}/auth/v1/token?grant_type=${type}`, {
    method: "POST",
    headers: { apikey: cfg.supabaseKey, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const json = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
    msg?: string;
  };
  if (!response.ok || !json.access_token || !json.refresh_token) {
    throw new AnalystError(
      `the analyst service login failed (${json.error_description ?? json.msg ?? response.status})`,
      502,
      "not_configured",
    );
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

async function signIn(cfg: Config): Promise<Token> {
  if (token) {
    try {
      return await grant(cfg, { refresh_token: token.refresh }, "refresh_token");
    } catch {
      // A refresh token is single-use and can be revoked; a fresh password sign-in recovers.
    }
  }
  return grant(cfg, { email: cfg.email, password: cfg.password }, "password");
}

async function serviceToken(cfg: Config, force = false): Promise<string> {
  if (!force && token && token.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return token.access;
  // One sign-in for however many requests arrive while it is in flight.
  pending ??= signIn(cfg)
    .then((t) => (token = t))
    .finally(() => {
      pending = null;
    });
  return (await pending).access;
}

// ── Calls ─────────────────────────────────────────────────────────────────────

type Options = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Sent as JSON. */
  body?: unknown;
  /**
   * Sent as-is instead of `body` — a browser upload streamed through with its own multipart
   * content-type (the boundary lives in that header, so it must travel with the bytes).
   */
  raw?: { stream: ReadableStream<Uint8Array>; contentType: string; length?: string | null };
  signal?: AbortSignal;
  /** Streaming calls pass their own signal and no timeout; JSON calls get the default. */
  timeoutMs?: number | null;
  accept?: string;
};

async function send(cfg: Config, path: string, options: Options, bearer: string): Promise<Response> {
  const signals: AbortSignal[] = [];
  if (options.signal) signals.push(options.signal);
  if (options.timeoutMs !== null) signals.push(AbortSignal.timeout(options.timeoutMs ?? cfg.timeoutMs));

  try {
    return await fetch(`${cfg.apiUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        accept: options.accept ?? "application/json",
        authorization: `Bearer ${bearer}`,
        ...(options.raw
          ? {
              "content-type": options.raw.contentType,
              ...(options.raw.length ? { "content-length": options.raw.length } : {}),
            }
          : options.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
      },
      body: options.raw ? options.raw.stream : options.body === undefined ? undefined : JSON.stringify(options.body),
      // Node's fetch refuses a streamed request body without this.
      ...(options.raw ? { duplex: "half" } : {}),
      signal: signals.length ? AbortSignal.any(signals) : undefined,
      // Per-request reads; caching one would serve a stale thread or connection list.
      cache: "no-store",
    });
  } catch (error) {
    if (options.signal?.aborted) throw error; // the caller went away; not ours to report
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new AnalystError(
      timedOut
        ? "the analyst service did not respond in time — it may be waking up, try again in a minute"
        : "could not reach the analyst service",
      504,
      "upstream",
    );
  }
}

/** Perform a call as the service account, re-signing in once if the agent refuses the token. */
export async function agentFetch(path: string, options: Options = {}): Promise<Response> {
  const cfg = config();
  let response = await send(cfg, path, options, await serviceToken(cfg));
  // A streamed upload has been consumed by the first attempt and cannot be sent twice; the
  // token is refreshed ahead of expiry, so a 401 there is a real login problem anyway.
  if (response.status === 401 && !options.raw) {
    response = await send(cfg, path, options, await serviceToken(cfg, true));
  }
  return response;
}

/** Call and parse, throwing a normalised AnalystError on any non-2xx. */
export async function agentJson<T>(path: string, options: Options = {}): Promise<T> {
  const response = await agentFetch(path, options);
  if (!response.ok) throw await normalizeAgentError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Whether the agent answers at all, within five seconds. A sleeping Render service does not. */
export async function agentAwake(): Promise<boolean> {
  try {
    const cfg = config();
    const response = await fetch(`${cfg.apiUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}
