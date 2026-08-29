/**
 * Shared loader for the security report exports (Excel / PDF / Word). Applies the
 * same severity/category/status filters as the dashboard so an export matches the
 * on-screen view.
 */
import { desc, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { securityFindings, securityScanRuns } from "@/lib/db/schema";
import { SEVERITIES, severityRank, type Severity } from "./severity";
import type { SecurityCategory } from "./types";

const ACTIVE_STATUSES = ["open", "acknowledged"];

export interface ReportFilters {
  severity?: string | null;
  category?: string | null;
  status?: string | null;
}

export interface ReportFinding {
  severity: Severity;
  category: SecurityCategory;
  title: string;
  summary: string;
  target_url: string;
  http_method: string | null;
  reproduction: string | null;
  remediation: string | null;
  owasp_ref: string | null;
  cwe_ref: string | null;
  confidence: string;
  status: string;
  check_slug: string;
  created_at: string | null;
}

export interface ReportData {
  generatedAt: Date;
  run: {
    target_env: string;
    target_base_url: string;
    mode: string;
    started_at: string | null;
    findings_total: number;
  } | null;
  counts: Record<Severity, number>;
  findings: ReportFinding[];
}

export async function loadReportData(filters: ReportFilters): Promise<ReportData> {
  const statusFilter = filters.status && filters.status !== "active" ? [filters.status] : ACTIVE_STATUSES;

  const rows = await db
    .select()
    .from(securityFindings)
    .where(inArray(securityFindings.status, statusFilter))
    .orderBy(desc(securityFindings.created_at));

  const sev = filters.severity as Severity | undefined;
  const cat = filters.category as SecurityCategory | undefined;

  const findings: ReportFinding[] = rows
    .filter((r) => (sev ? r.severity === sev : true))
    .filter((r) => (cat ? r.category === cat : true))
    .map((r) => ({
      severity: r.severity as Severity,
      category: r.category as SecurityCategory,
      title: r.title,
      summary: r.summary,
      target_url: r.target_url,
      http_method: r.http_method,
      reproduction: r.reproduction,
      remediation: r.remediation,
      owasp_ref: r.owasp_ref,
      cwe_ref: r.cwe_ref,
      confidence: r.confidence,
      status: r.status,
      check_slug: r.check_slug,
      created_at: r.created_at?.toISOString() ?? null,
    }))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  const [runRow] = await db
    .select({
      target_env: securityScanRuns.target_env,
      target_base_url: securityScanRuns.target_base_url,
      mode: securityScanRuns.mode,
      started_at: securityScanRuns.started_at,
      findings_total: securityScanRuns.findings_total,
    })
    .from(securityScanRuns)
    .orderBy(desc(securityScanRuns.started_at))
    .limit(1);

  return {
    // Callers stamp their own timestamp label; new Date() is fine here (route runtime).
    generatedAt: new Date(),
    run: runRow
      ? {
          target_env: runRow.target_env,
          target_base_url: runRow.target_base_url,
          mode: runRow.mode,
          started_at: runRow.started_at?.toISOString() ?? null,
          findings_total: runRow.findings_total,
        }
      : null,
    counts,
    findings,
  };
}

export function filtersFromSearchParams(sp: URLSearchParams): ReportFilters {
  return {
    severity: sp.get("severity"),
    category: sp.get("category"),
    status: sp.get("status"),
  };
}

export const REPORT_SEVERITY_ORDER = SEVERITIES;
