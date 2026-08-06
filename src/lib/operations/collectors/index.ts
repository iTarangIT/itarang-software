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
import { databaseCollector } from "./database";
import { hostCollector } from "./host";
import { jobsCollector } from "./jobs";
import { logsCollector } from "./logs";
import { spendCollector } from "./spend";
import { teamCollector } from "./team";
import type { OpsCollector } from "./types";
import { vendorCollectors } from "./vendors";

export const COLLECTORS: OpsCollector[] = [
  appHealthCollector,
  jobsCollector,
  hostCollector,
  databaseCollector,
  logsCollector,
  spendCollector,
  ...vendorCollectors,
  businessCollector,
  teamCollector,
  // Every metric in registry.ts now has a collector behind it. Phase 6 adds no
  // new ones — it adds daily.ts (the snapshot rollup) and alerts.ts (threshold
  // evaluation), which consume what these already write.
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
