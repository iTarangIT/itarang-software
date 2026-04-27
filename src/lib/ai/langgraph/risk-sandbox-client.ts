/**
 * Phase D — client for the risk-sandbox HTTP service.
 *
 * The sandbox container (deployed via phase6_risk_sandbox.sh on the VPS) runs
 * a tiny FastAPI app on port 8000 that exec()s LLM-generated Python against
 * tenant data and returns a JSON verdict. We talk to it over HTTP — same
 * docker network as the IoT bridge in production, or a local SSH tunnel in
 * dev (see SANDBOX_URL env).
 *
 * Phase B used a single-shot tool-call verdict ("ask the LLM what severity
 * this is"). Phase D upgrades that: the LLM produces a Python `evaluate()`
 * function, we run it on real data, the verdict comes from numbers not vibes.
 */

const SANDBOX_URL = process.env.NBFC_SANDBOX_URL ?? "http://127.0.0.1:8091";

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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
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
