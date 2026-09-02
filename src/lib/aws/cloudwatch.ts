/**
 * Server-only AWS CloudWatch client, for RDS instance metrics.
 *
 * WHY THIS EXISTS. The Database Health page reads everything it can from
 * pg_stat_*, deliberately — see collectors/database.ts. But CPU, freeable
 * memory, volume free space, disk queue depth and burst-credit balance are
 * facts about the MACHINE, and no query can reach them. They are also the
 * numbers that explain why the Postgres-level numbers went bad: a cache hit
 * ratio that collapses because the working set outgrew a 1 GiB instance is a
 * different incident from one caused by a missing index, and until this client
 * existed the page could not tell those apart.
 *
 * OPT-IN, AND SILENT WHEN OFF. Everything here is gated on
 * OPS_RDS_INSTANCE_ID. With it unset, `rdsInstanceId()` returns null, the
 * collector writes nothing, and the page renders exactly as it did before —
 * no failed API calls, no error tiles, no cost. The pg_stat_* collector is
 * untouched either way.
 *
 * Credentials follow src/lib/storage/s3.ts exactly rather than inventing a
 * second convention: explicit keys when present, otherwise the default provider
 * chain so a VPS or task role works without configuration.
 */

import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";

const REGION = process.env.AWS_REGION;

/**
 * Which RDS instance to ask about — `database-1` on sandbox, `database-2` on
 * production.
 *
 * NOT DERIVED FROM DATABASE_URL, though it could be. The hostname's first label
 * happens to be the instance identifier today, but that is a coincidence of how
 * these instances were named, not a rule: an RDS endpoint can be a CNAME, and a
 * read replica or a restored snapshot would break the inference while still
 * connecting fine. Getting this wrong reports another database's health under
 * this one's name — a failure that looks entirely correct on screen — so it is
 * stated explicitly and echoed back onto the card where a mismatch is visible.
 */
export function rdsInstanceId(): string | null {
  const id = process.env.OPS_RDS_INSTANCE_ID?.trim();
  return id ? id : null;
}

let _client: CloudWatchClient | null = null;

/** The shared client. Throws only when the region is missing. */
export function cloudWatchClient(): CloudWatchClient {
  if (!_client) {
    if (!REGION) throw new Error("cloudwatch: AWS_REGION not set");
    _client = new CloudWatchClient({
      region: REGION,
      // Explicit keys if present, else the default provider chain
      // (instance role / shared config) — same rule as the S3 backend.
      credentials:
        process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
          ? {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            }
          : undefined,
      // One attempt beyond the first. The collector runs every 5 minutes
      // against a 10-minute lookback window, so a transient failure costs
      // nothing and is better than holding a runner slot through a long
      // exponential backoff — runner.ts caps this collector at 20 seconds.
      maxAttempts: 2,
    });
  }
  return _client;
}
