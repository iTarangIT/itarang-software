import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatIst, formatMinutesAgo, minutesSince } from "@/lib/operations/format";
import type { JobHealth } from "@/lib/operations/scheduledJobs";
import type { ScheduledJobsReport, ScheduledJobStatus } from "@/lib/operations/scheduledJobsStatus";

/**
 * ID 227 — Ops Console > Jobs: every scheduled job, what runs it on this
 * server, and when it last ran. Business check: "lists every scheduled job
 * with its last run today".
 */

const HEALTH: Record<JobHealth, { label: string; variant: "success" | "warning" | "danger" | "muted" | "info" }> = {
  ok: { label: "OK", variant: "success" },
  late: { label: "Late", variant: "warning" },
  failed: { label: "Failed", variant: "danger" },
  never: { label: "No run yet", variant: "warning" },
  pending: { label: "Not recorded yet", variant: "muted" },
  off: { label: "Off", variant: "muted" },
  covered: { label: "Covered", variant: "info" },
};

function istToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

function LastRun({ job, today }: { job: ScheduledJobStatus; today: string }) {
  if (job.runnerKind !== "ticker") return <span className="text-ink-muted">—</span>;
  const tick = job.lastFinishedAt;
  return (
    <div className="space-y-0.5">
      {job.dailyDate !== null || job.schedule.startsWith("daily at") ? (
        <div className="text-ink">
          {job.dailyDate === today
            ? `Ran today${job.dailyStatus === "failed" ? " — failed" : ""}`
            : job.dailyDate
              ? `Last ran ${job.dailyDate}`
              : "No daily run recorded"}
        </div>
      ) : null}
      {tick ? (
        <>
          <div className="tabular-nums text-ink-muted">
            {job.dailyDate !== null || job.schedule.startsWith("daily at") ? "checked " : ""}
            {formatMinutesAgo(minutesSince(tick))}
          </div>
          <div className="text-[11px] text-ink-muted">{formatIst(tick)}</div>
        </>
      ) : (
        <div className="text-ink-muted">never</div>
      )}
    </div>
  );
}

export function ScheduledJobsCard({ report }: { report: ScheduledJobsReport }) {
  const now = new Date(report.generatedAt);
  const today = istToday(now);
  const count = (h: JobHealth) => report.jobs.filter((j) => j.health === h).length;
  const ranToday = report.jobs.filter(
    (j) => j.runnerKind === "ticker" && j.lastFinishedAt && istToday(new Date(j.lastFinishedAt)) === today,
  ).length;
  const tickers = report.jobs.filter((j) => j.runnerKind === "ticker").length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Scheduled jobs</CardTitle>
        <p className="mt-1 text-xs text-ink-muted">
          Every job the CRM runs on a timer, on this server. vercel.json schedules do not fire here, so each job is
          run in-process, covered by another job, or deliberately off.
        </p>
      </CardHeader>
      <CardContent>
        {!report.stateTable && (
          <p className="mb-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-ink">
            Last runs are not recorded on this database yet: apply <code>drizzle/E-372_scheduled_job_state.sql</code>{" "}
            (<code>node scripts/_apply-e372.mjs database-1|database-2</code>). Once-a-day jobs still show their last day.
          </p>
        )}
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <Badge variant={ranToday === tickers ? "success" : "muted"}>
            {ranToday} of {tickers} ran today
          </Badge>
          <Badge variant={count("failed") > 0 ? "danger" : "muted"}>{count("failed")} failed</Badge>
          <Badge variant={count("late") + count("never") > 0 ? "warning" : "muted"}>
            {count("late") + count("never")} late or not run
          </Badge>
          <Badge variant="muted">{count("off")} off</Badge>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                <th className="py-2 pr-3">Job</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Runs</th>
                <th className="py-2 pr-3">Last run</th>
                <th className="py-2 pl-3">Notes</th>
              </tr>
            </thead>
            <tbody>
              {report.jobs.map((job) => {
                const h = HEALTH[job.health];
                return (
                  <tr key={job.id} className="border-b border-border/60 align-top last:border-0">
                    <td className="py-2.5 pr-3">
                      <div className="font-medium text-ink">{job.title}</div>
                      <div className="max-w-[24rem] text-[11px] text-ink-muted">{job.what}</div>
                      {job.jobName && <div className="font-mono text-[11px] text-ink-muted">{job.jobName}</div>}
                    </td>
                    <td className="py-2.5 pr-3">
                      <Badge variant={h.variant}>{h.label}</Badge>
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-ink-muted">{job.schedule}</td>
                    <td className="py-2.5 pr-3 text-xs">
                      <LastRun job={job} today={today} />
                    </td>
                    <td className="py-2.5 pl-3 text-[11px] text-ink-muted">
                      {job.note && <div className="max-w-[26rem]">{job.note}</div>}
                      {job.lastError && job.health === "failed" && (
                        <div className="mt-1 max-w-[26rem] truncate text-danger" title={job.lastError}>
                          {job.lastError}
                        </div>
                      )}
                      {job.offSwitch && <div className="mt-1">Off switch: {job.offSwitch}=0</div>}
                      {job.cronPaths.length > 0 && (
                        <div className="mt-1 font-mono">{job.cronPaths.join(", ")}</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
