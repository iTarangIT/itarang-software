/**
 * Every registered collector, as one flat array.
 *
 * ADDING A MONITOR: write the collector file, add its metric(s) to
 * ../registry.ts, and add one line here. Nothing else in the system changes —
 * the runner, /operations/jobs, thresholds and alerting all read from this
 * list.
 *
 * Ids must be unique and stable: they are the collector_id in
 * ops_collector_runs and the single-flight lock is keyed on them.
 */

import { appHealthCollector } from "./appHealth";
import { businessCollector } from "./business";
import { cloudwatchCollector } from "./cloudwatch";
import { databaseCollector } from "./database";
import { hostCollector } from "./host";
import { jobsCollector } from "./jobs";
import { logsCollector } from "./logs";
import { spendCollector } from "./spend";
import { teamCollector } from "./team";
import type { OpsCollector } from "./types";
import { usageCollector } from "./usage";
import { vendorCollectors } from "./vendors";

export const COLLECTORS: OpsCollector[] = [
  appHealthCollector,
  jobsCollector,
  hostCollector,
  databaseCollector,
  // The hypervisor's view of the same RDS instance databaseCollector probes
  // over SQL. Separate on purpose: an IAM or credential failure here must never
  // cost us the connection-headroom numbers above. Inert until
  // OPS_RDS_INSTANCE_ID is set.
  cloudwatchCollector,
  logsCollector,
  spendCollector,
  ...vendorCollectors,
  businessCollector,
  teamCollector,
  // CRM usage (E-214). Reads our own tables, unlike teamCollector which asks
  // Supabase — the two measure different things and are meant to differ.
  usageCollector,
];

// Duplicate ids would silently share a lock, so one collector would
// permanently starve the other. Fail loudly at import instead.
const seen = new Set<string>();
for (const c of COLLECTORS) {
  if (seen.has(c.id)) {
    throw new Error(`Duplicate ops collector id: ${c.id}`);
  }
  seen.add(c.id);
}

export type { OpsCollector };
