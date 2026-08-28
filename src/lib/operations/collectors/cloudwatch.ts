/**
 * RDS instance health, from CloudWatch.
 *
 * The counterpart to collectors/database.ts, and deliberately a SEPARATE FILE.
 * That collector's header calls it "the highest-value monitor in the build" and
 * it earns that by needing nothing but a Postgres connection — no AWS SDK, no
 * IAM, no credentials that can expire. Adding an AWS dependency to it would put
 * connection-headroom, the one number that predicts an outage, behind an IAM
 * policy. So this file exists alongside it and the two never interact: if
 * CloudWatch is misconfigured, unreachable or unauthorised, every pg_stat_*
 * tile on the page is unaffected.
 *
 * WHAT IT ADDS. CPU, freeable memory, volume free space, disk queue depth and
 * burst-credit balance — hypervisor-level facts no query can reach, and the
 * ones that explain WHY the Postgres numbers went bad.
 *
 * OPT-IN. With OPS_RDS_INSTANCE_ID unset this returns immediately and writes
 * nothing, so the default behaviour of the console is exactly what it was.
 *
 * SCOPE IS THE CRM INSTANCE ONLY. The IoT database is reached through an SSH
 * tunnel to a bastion and lives in a different RDS resource namespace, almost
 * certainly a different AWS account; asking this account's CloudWatch about it
 * would fail on every cycle to tell us nothing.
 */

import {
  GetMetricDataCommand,
  type MetricDataResult,
} from "@aws-sdk/client-cloudwatch";

import { cloudWatchClient, rdsInstanceId } from "@/lib/aws/cloudwatch";
import {
  buildMetricQueries,
  latestDatapoint,
  lookbackWindow,
  queryId,
  RDS_METRIC_SPECS,
} from "@/lib/operations/cloudwatchMath";
import { rootCauseMessage } from "@/lib/operations/errors";

import type { CollectedSample, OpsCollector } from "./types";
import { MINUTE } from "./types";

/**
 * The instance these samples describe.
 *
 * Same source string the pg_stat_* collector uses, ON PURPOSE: the read model
 * groups by source, so writing "rds:crm" lands these on the existing CRM card
 * with no routing, no new instance key and no change to KNOWN_INSTANCES. One
 * card, two data sources.
 */
const SOURCE = "rds:crm";

export const cloudwatchCollector: OpsCollector = {
  id: "db.cloudwatch",
  label: "Database instance (CloudWatch)",
  // Five minutes against RDS's 60-second publication. Polling faster costs more
  // per month and gains nothing: the page auto-refreshes off stored samples, so
  // its 30-second refresh is unrelated to how often we call AWS.
  intervalMs: 5 * MINUTE,
  // One HTTPS round trip. The default 10s would be plenty; 20s is headroom for
  // a slow TLS handshake on a cold lambda-ish process rather than an
  // expectation.
  timeoutMs: 20_000,

  async run(): Promise<CollectedSample[]> {
    const instanceId = rdsInstanceId();

    // ---- not configured -----------------------------------------------------
    // A deployment fact, not a fault, and the page renders it differently from
    // a failure. Carried as a valueless sample with a reason rather than as an
    // empty return, so the section can say "this was never switched on"
    // instead of looking identical to a collector that ran and found nothing.
    if (!instanceId) {
      return [
        {
          metric_key: "rds.cloudwatch_ok",
          source: SOURCE,
          value_num: null,
          value_text: "not configured: OPS_RDS_INSTANCE_ID is not set",
          meta: { configured: false, instance_id: null },
        },
      ];
    }

    const { start, end } = lookbackWindow(new Date());

    let results: MetricDataResult[];
    try {
      const response = await cloudWatchClient().send(
        new GetMetricDataCommand({
          MetricDataQueries: buildMetricQueries(instanceId),
          StartTime: start,
          EndTime: end,
          ScanBy: "TimestampDescending",
        }),
      );
      results = response.MetricDataResults ?? [];
    } catch (e) {
      // Invalid credentials, a missing IAM permission, a network failure, a
      // wrong region. All of them mean the same thing to the page — we could
      // not ask — and all of them must leave the pg_stat_* tiles alone.
      return [
        {
          metric_key: "rds.cloudwatch_ok",
          source: SOURCE,
          value_num: 0,
          value_text: `CloudWatch: ${rootCauseMessage(e)}`,
          meta: { configured: true, instance_id: instanceId },
        },
      ];
    }

    // Results come back keyed by the Id we sent, not by metric name, and the
    // service does not promise the request order.
    const byId = new Map(results.map((r) => [r.Id, r]));

    const samples: CollectedSample[] = [
      {
        metric_key: "rds.cloudwatch_ok",
        source: SOURCE,
        value_num: 1,
        meta: {
          configured: true,
          // Echoed so a wrong OPS_RDS_INSTANCE_ID is visible on the card rather
          // than silently reporting a different database's health under this
          // one's name — the worst failure available here, because it looks
          // entirely correct.
          instance_id: instanceId,
          window_start: start.toISOString(),
          window_end: end.toISOString(),
        },
      },
    ];

    for (const [i, spec] of RDS_METRIC_SPECS.entries()) {
      const point = latestDatapoint(
        byId.get(queryId(i))?.Timestamps,
        byId.get(queryId(i))?.Values,
      );

      // NO SAMPLE AT ALL when there is no datapoint — not a null one, and
      // certainly not a zero. Two different reasons converge here:
      //
      //   the metric does not exist for this instance class (CPU credits on a
      //     non-burstable instance), in which case a tile should never appear;
      //   the metric exists but this window was empty, in which case the
      //     previous reading is still the best thing we know and the page's
      //     staleness line will say how old it is.
      //
      // Writing a null would break the second case by replacing a good reading
      // with a blank, and writing a zero would claim a full volume or an idle
      // CPU. Same rule as databaseMath.ts: omit rather than invent.
      if (!point) continue;

      samples.push({
        metric_key: spec.key,
        source: SOURCE,
        value_num: point.value,
        // BACK-DATED to the datapoint's own timestamp. CloudWatch publishes
        // 2-3 minutes late, so stamping these with now() would claim a
        // freshness the reading does not have and the tile's 15-minute stale
        // line — which exists to catch exactly that — would never fire.
        captured_at: point.at,
        meta: {
          metric_name: spec.metricName,
          stat: spec.stat,
          instance_id: instanceId,
        },
      });
    }

    return samples;
  },
};
