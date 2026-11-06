// ID 227 — the NBFC nightly jobs, run in-process once per IST day.
//
// vercel.json scheduled these four as separate crons around 00:00-00:30 UTC
// (05:30-06:00 IST); none of them fires on the PM2 live server
// (docs/DEPLOY_RUNBOOK.md). They read and write NBFC tables only and send
// nothing:
//   1. CDS — borrower risk scores (computeCds.ts).
//   2. PCI — per-loan concern index; reads the CDS just written, so it runs
//      second (computePci.ts).
//   3. Anomaly flags per lender (anomalyFlags.ts; "notify" is a log line).
//   4. COR (certificate of registration) expiry alerts, 60-day window
//      (checkNbfcCorExpiryJob.ts; no notifier passed = no email).
// Each step has its own try, so one failing step does not stop the others;
// the day is marked failed (and retried by a later tick) if any step failed.

export type NbfcNightlyCounts = {
  cds?: { computed: number; skipped: number };
  pci?: Record<string, unknown>;
  anomaly?: { evaluated: number; flagged: number; cleared: number };
  cor_expiry?: Record<string, unknown>;
  errors: Record<string, string>;
  failed: boolean;
  error?: string;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runNbfcNightly(): Promise<NbfcNightlyCounts> {
  const out: NbfcNightlyCounts = { errors: {}, failed: false };

  try {
    const { runCdsNightlyJob } = await import("@/lib/nbfc/cds/computeCds");
    const r = await runCdsNightlyJob();
    out.cds = { computed: r.computed_count, skipped: r.skipped_count };
  } catch (e) {
    out.errors.cds = message(e);
  }

  try {
    const { computePciForAllLoans } = await import("@/lib/nbfc/pci/computePci");
    const r = await computePciForAllLoans();
    out.pci = { ...(r as unknown as Record<string, unknown>) };
    // The result can carry per-loan detail; keep the stored counts small.
    for (const [k, v] of Object.entries(out.pci)) if (Array.isArray(v)) out.pci[k] = v.length;
  } catch (e) {
    out.errors.pci = message(e);
  }

  try {
    const { evaluateAnomalyFlags } = await import("@/lib/nbfc/anomalyFlags");
    const r = await evaluateAnomalyFlags();
    out.anomaly = { evaluated: r.evaluated_count, flagged: r.flagged.length, cleared: r.cleared.length };
  } catch (e) {
    out.errors.anomaly = message(e);
  }

  try {
    const { checkNbfcCorExpiryJob } = await import("@/lib/queue/jobs/checkNbfcCorExpiryJob");
    const r = await checkNbfcCorExpiryJob({ windowDays: 60 });
    out.cor_expiry = { ...(r as unknown as Record<string, unknown>) };
    for (const [k, v] of Object.entries(out.cor_expiry)) if (Array.isArray(v)) out.cor_expiry[k] = v.length;
  } catch (e) {
    out.errors.cor_expiry = message(e);
  }

  const failedSteps = Object.keys(out.errors);
  if (failedSteps.length > 0) {
    out.failed = true;
    out.error = failedSteps.map((s) => `${s}: ${out.errors[s]}`).join("; ").slice(0, 500);
  }
  return out;
}
