/**
 * Client for the risk-sandbox HTTP service (source: services/risk-sandbox/).
 *
 * The sandbox runs a FastAPI app that executes agent-authored Python against
 * tenant data and returns a JSON verdict. It is the reason the risk engine no
 * longer asks an LLM to *state* a severity: the model writes the test, the
 * sandbox runs it, and the numbers come from data. When this service is
 * unreachable the caller reports `inconclusive` — it does not guess.
 *
 * The sandbox is bound to loopback on the CRM's own host (127.0.0.1:8091 →
 * container :8000) and requires a bearer token.
 */

const SANDBOX_URL = process.env.NBFC_SANDBOX_URL ?? "http://127.0.0.1:8091";

/**
 * Must match SANDBOX_TOKEN in the sandbox's environment. Without it the service
 * returns 401 — which surfaces as an inconclusive card rather than a bad verdict,
 * so a misconfigured token degrades honestly instead of silently.
 */
const SANDBOX_TOKEN = process.env.NBFC_SANDBOX_TOKEN ?? "";

function authHeaders(): Record<string, string> {
  return SANDBOX_TOKEN ? { Authorization: `Bearer ${SANDBOX_TOKEN}` } : {};
}

export interface SandboxRequest {
  hypothesis_slug: string;
  /** Python source defining `def evaluate(**kwargs) -> dict` */
  code: string;
  /** Each value will be turned into a pandas.DataFrame inside the sandbox */
  data: Record<string, unknown[]>;
}

export interface SandboxResponse {
  ok: boolean;
  result?: {
    severity?: "high" | "warn" | "ok";
    affected_count?: number;
    total_count?: number;
    finding_summary?: string;
    evidence?: { sample_rows?: unknown[]; notes?: string[] };
  };
  error?: string;
  elapsed_ms: number;
}

/**
 * Invoke the sandbox with a 35s client-side cap (sandbox itself caps at 30s).
 * Throws on transport errors; returns {ok:false,error} for in-sandbox errors.
 */
export async function executeInSandbox(req: SandboxRequest): Promise<SandboxResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const r = await fetch(`${SANDBOX_URL}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    if (r.status === 401) {
      return {
        ok: false,
        error: "sandbox rejected our token — check NBFC_SANDBOX_TOKEN matches SANDBOX_TOKEN",
        elapsed_ms: 0,
      };
    }
    if (!r.ok) {
      return { ok: false, error: `sandbox HTTP ${r.status}`, elapsed_ms: 0 };
    }
    return (await r.json()) as SandboxResponse;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      return { ok: false, error: "sandbox timeout (>35s client cap)", elapsed_ms: 35_000 };
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function sandboxHealthy(): Promise<boolean> {
  try {
    const r = await fetch(`${SANDBOX_URL}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
