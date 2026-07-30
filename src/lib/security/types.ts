/**
 * Shared types for the CRM security scanner. Kept free of any Playwright import
 * so the DB/dashboard side can depend on it without pulling the browser stack.
 */
import type { Severity } from "./severity";

export type SecurityCategory = "authz" | "exposure" | "injection" | "upload_headers";

export type ScanMode = "safe" | "aggressive";

export type TargetEnv = "local" | "sandbox" | "prod";

export type Confidence = "confirmed" | "likely" | "possible";

export const CATEGORY_LABELS: Record<SecurityCategory, string> = {
  authz: "Broken Access Control",
  exposure: "Sensitive Data Exposure",
  injection: "Injection / XSS",
  upload_headers: "Upload & Security Headers",
};

/**
 * A raw finding as emitted by a probe. `target_url` may be relative — the engine
 * normalises it against the base URL and computes the dedup fingerprint. The
 * probe sets `severity` and `confidence`; the LLM triage step may later fill or
 * refine `summary`/`remediation`/`owasp_ref`/`cwe_ref` but MUST NOT change
 * `severity`.
 */
export interface RawFinding {
  check_slug: string;
  category: SecurityCategory;
  severity: Severity;
  title: string;
  summary: string;
  target_url: string;
  http_method?: string;
  evidence?: Record<string, unknown>;
  reproduction?: string;
  remediation?: string;
  owasp_ref?: string;
  cwe_ref?: string;
  confidence: Confidence;
}

/** Static metadata a probe advertises; used to seed the `security_checks` catalogue. */
export interface ProbeMeta {
  slug: string;
  category: SecurityCategory;
  title: string;
  description: string;
  /** Fallback severity for the catalogue row (individual findings pin their own). */
  default_severity: Severity;
  /** True if the probe writes/mutates server state — skipped in `safe` mode. */
  mutating: boolean;
  owasp_ref?: string;
  cwe_ref?: string;
}
