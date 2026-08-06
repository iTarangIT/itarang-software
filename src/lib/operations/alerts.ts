/**
 * Threshold evaluation: open, escalate, resolve, notify.
 *
 * Runs every tick. Three properties matter more than anything else here, and
 * each is enforced by the database rather than by hoping the code is careful:
 *
 *   ONE ALERT PER PROBLEM. The partial unique index
 *   `(metric_key, source) WHERE resolved_at IS NULL` from E-210 means a metric
 *   sitting exactly on its threshold and flapping cannot spawn a row per tick.
 *   The INSERT is ON CONFLICT DO NOTHING; the index is the lock.
 *
 *   NOTIFY EXACTLY ONCE. `notified_at` is stamped when a notification goes out
 *   and re-checked under cooldown_minutes before the next one. A tick that
 *   crashes after notifying but before stamping would re-notify — so the stamp
 *   happens in the same UPDATE that claims the right to send.
 *
 *   NEVER FALSELY RECOVER. An alert auto-resolves only when a FRESH sample says
 *   the metric is healthy. A metric that stops arriving leaves its alert open,
 *   because "we stopped hearing about the disk" is not "the disk got better".
 *
 * Thresholds live in ops_alert_rules, seeded from registry.ts defaults on first
 * sight and owned by whoever edits them afterwards. The seed never overwrites:
 * a threshold someone tuned by hand must survive a deploy.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { notifyRoles } from "@/lib/notifications/notify";

import { candidatesForRule, shadowedSources } from "./alertRouting";
import { rootCauseMessage } from "./errors";
import { formatMetricValue } from "./format";
import { comparatorFor, getMetric, METRICS, severityForRule } from "./registry";

/**
 * A sample older than this is not evidence of anything.
 *
 * Two hours is comfortably longer than the slowest collector's interval (60
 * minutes for the vendor and spend collectors) so a healthy-but-slow metric is
 * never treated as missing, and short enough that a genuinely dead feed stops
 * driving alerts within one working coffee break.
 */
const MAX_SAMPLE_AGE_HOURS = 2;

export interface AlertEvaluation {
  rules_seeded: number;
  opened: number;
  resolved: number;
  notified: number;
}

/**
 * Create a rule for every registry metric that declares a threshold.
 *
 * ON CONFLICT DO NOTHING against UNIQUE(metric_key, source). Source is '*' —
 * one rule covers host:prod, host:sandbox and host:iot rather than needing
 * three near-identical rows.
 */
export async function seedAlertRules(): Promise<number> {
  const seedable = METRICS.filter(
    (m) => m.direction !== "neutral" && (m.warn != null || m.crit != null),
  );
  if (seedable.length === 0) return 0;

  const values = seedable.map(
    (m) =>
      sql`(${m.key}, '*', ${comparatorFor(m)}, ${m.warn ?? null}, ${m.crit ?? null})`,
  );

  const inserted = (await db.execute(sql`
    INSERT INTO ops_alert_rules (metric_key, source, comparator, warn_threshold, crit_threshold)
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (metric_key, source) DO NOTHING
    RETURNING id
  `)) as unknown as Array<Record<string, unknown>>;

  return inserted.length;
}

interface RuleRow {
  id: string;
  metric_key: string;
  source: string;
  comparator: string;
  warn_threshold: number | null;
  crit_threshold: number | null;
  cooldown_minutes: number;
  notify_channels: unknown;
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function describe(
  metricKey: string,
  source: string,
  value: number,
  threshold: number,
  comparator: string,
): string {
  const def = getMetric(metricKey);
  const unit = def?.unit ?? "count";
  const label = def?.label ?? metricKey;
  const direction = comparator === "lt" ? "below" : "above";
  return `${label} on ${source} is ${formatMetricValue(value, unit)} — ${direction} the ${formatMetricValue(threshold, unit)} threshold.`;
}

/**
 * Evaluate every enabled rule against the newest fresh sample per source.
 *
 * Never throws: this runs on the ticker, and an alerting system that takes the
 * collector runner down with it is worse than one that is briefly quiet.
 */
export async function evaluateAlerts(): Promise<AlertEvaluation> {
  const result: AlertEvaluation = {
    rules_seeded: 0,
    opened: 0,
    resolved: 0,
    notified: 0,
  };

  try {
    result.rules_seeded = await seedAlertRules();

    // Coerce on the way in. Postgres `numeric` is returned as a STRING by the
    // driver (to avoid float precision loss), so warn_threshold arrives as
    // "70.0000". The comparisons below would still work by JS coercion, but
    // formatMetricValue() calls .toFixed() on percent and ms units and throws
    // on a string — a bug that only appears when a percent metric breaches,
    // which is exactly the kind that ships. format.ts documents this trap and
    // exports toNumber() for it.
    const ruleRows = (await db.execute(sql`
      SELECT id, metric_key, source, comparator, warn_threshold, crit_threshold,
             cooldown_minutes, notify_channels
      FROM ops_alert_rules
      WHERE enabled = TRUE
    `)) as unknown as Array<Record<string, unknown>>;

    const rules: RuleRow[] = ruleRows.map((r) => ({
      id: String(r.id),
      metric_key: String(r.metric_key),
      source: String(r.source),
      comparator: String(r.comparator),
      warn_threshold: num(r.warn_threshold),
      crit_threshold: num(r.crit_threshold),
      cooldown_minutes: Number(r.cooldown_minutes ?? 60),
      notify_channels: r.notify_channels,
    }));

    if (rules.length === 0) return result;

    // Newest fresh sample per (metric_key, source), for every metric any rule
    // covers. One query rather than one per rule — there are ~40 rules and this
    // runs every 60 seconds against the database the console is protecting.
    const keys = [...new Set(rules.map((r) => r.metric_key))];
    const samples = (await db.execute(sql`
      SELECT DISTINCT ON (metric_key, source) metric_key, source, value_num, captured_at
      FROM ops_metric_samples
      WHERE metric_key IN ${keys}
        AND captured_at > NOW() - MAKE_INTERVAL(hours => ${MAX_SAMPLE_AGE_HOURS})
        AND value_num IS NOT NULL
      ORDER BY metric_key, source, captured_at DESC
    `)) as unknown as Array<Record<string, unknown>>;

    // Rules are keyed by metric with source '*' meaning "any source", so one
    // rule fans out across every source that reported.
    const byMetric = new Map<string, Array<{ source: string; value: number }>>();
    for (const s of samples) {
      const value = num(s.value_num);
      if (value == null) continue;
      const key = s.metric_key as string;
      const list = byMetric.get(key) ?? [];
      list.push({ source: s.source as string, value });
      byMetric.set(key, list);
    }

    // A per-source rule shadows '*' for its own source — see alertRouting.ts.
    // Computed from `rules`, which is already filtered to enabled = TRUE, so
    // disabling an override hands its source back to the wildcard.
    const shadowed = shadowedSources(rules);

    for (const rule of rules) {
      const candidates = candidatesForRule(
        rule,
        byMetric.get(rule.metric_key) ?? [],
        shadowed.get(rule.metric_key),
      );

      for (const candidate of candidates) {
        const breach = severityForRule(rule, candidate.value);

        if (breach) {
          const message = describe(
            rule.metric_key,
            candidate.source,
            candidate.value,
            breach.threshold,
            rule.comparator,
          );

          // Open, or escalate an existing warn to crit. ON CONFLICT DO UPDATE
          // (not DO NOTHING) so a warn that worsens becomes a crit without
          // opening a second row — but only upwards: a crit that eases to warn
          // stays crit until it actually resolves, or the alert would flap
          // between severities and re-notify.
          const upserted = (await db.execute(sql`
            INSERT INTO ops_alerts
              (rule_id, metric_key, source, severity, value_num, threshold, message)
            VALUES (${rule.id}, ${rule.metric_key}, ${candidate.source},
                    ${breach.severity}, ${candidate.value}, ${breach.threshold}, ${message})
            ON CONFLICT (metric_key, source) WHERE resolved_at IS NULL
            DO UPDATE SET
              value_num = EXCLUDED.value_num,
              severity  = CASE WHEN ops_alerts.severity = 'warn' AND EXCLUDED.severity = 'crit'
                               THEN 'crit' ELSE ops_alerts.severity END,
              threshold = CASE WHEN ops_alerts.severity = 'warn' AND EXCLUDED.severity = 'crit'
                               THEN EXCLUDED.threshold ELSE ops_alerts.threshold END,
              message   = EXCLUDED.message
            RETURNING id, severity, notified_at, (xmax = 0) AS inserted
          `)) as unknown as Array<Record<string, unknown>>;

          const row = upserted[0];
          if (!row) continue;

          // `xmax = 0` is the Postgres idiom for "this upsert inserted rather
          // than updated" — the only way to tell a newly opened alert from one
          // that was already open, since RETURNING gives the post-update row.
          if (row.inserted === true) result.opened += 1;

          // Claim the right to notify in the same statement that stamps it, so
          // a crash between "decided to send" and "recorded that we sent"
          // cannot produce a duplicate on the next tick.
          const claimed = (await db.execute(sql`
            UPDATE ops_alerts
            SET notified_at = NOW()
            WHERE id = ${row.id as string}
              AND (notified_at IS NULL
                   OR notified_at < NOW() - MAKE_INTERVAL(mins => ${rule.cooldown_minutes}))
            RETURNING id
          `)) as unknown as Array<Record<string, unknown>>;

          if (claimed.length > 0) {
            await deliver(
              rule,
              breach.severity,
              rule.metric_key,
              candidate.source,
              message,
            );
            result.notified += 1;
          }
        } else {
          // Healthy, and we know it from a FRESH sample. Resolve any open alert.
          //
          // RETURNING notified_at so the recovery notice can be withheld for an
          // alert nobody was ever told about. An alert that opened and cleared
          // inside one cooldown window never sent a warning, and "Recovered: X"
          // for an X the reader never heard of is pure noise — the kind that
          // teaches people to filter the channel.
          //
          // Deliberately NOT a time gate on the resolve itself: when someone WAS
          // warned, they should learn it is over promptly, not cooldown_minutes
          // later.
          const resolved = (await db.execute(sql`
            UPDATE ops_alerts
            SET resolved_at = NOW(), status = 'resolved', value_num = ${candidate.value}
            WHERE metric_key = ${rule.metric_key}
              AND source = ${candidate.source}
              AND resolved_at IS NULL
            RETURNING id, notified_at
          `)) as unknown as Array<Record<string, unknown>>;

          if (resolved.length > 0) {
            result.resolved += resolved.length;
          }
          if (resolved.some((r) => r.notified_at != null)) {
            await deliver(
              rule,
              "resolved",
              rule.metric_key,
              candidate.source,
              `Recovered: ${getMetric(rule.metric_key)?.label ?? rule.metric_key} on ${candidate.source} is back within threshold.`,
            );
          }
        }
      }
    }
  } catch (e) {
    // log.error is rate-limited (30s dedupe), so a persistent failure here
    // cannot fill a disk — the reason src/lib/log.ts exists.
    log.error("[ops] alert evaluation failed", e);
  }

  return result;
}

/**
 * Send one notification. Best-effort by contract.
 *
 * A failed notification must never roll back the alert row: the breach is real
 * and belongs on /operations/alerts whether or not the email went out. Losing
 * the row because the mailer was down would hide the very thing we detected.
 */
async function deliver(
  rule: RuleRow,
  severity: "warn" | "crit" | "resolved",
  metricKey: string,
  source: string,
  message: string,
): Promise<void> {
  const channels = Array.isArray(rule.notify_channels)
    ? (rule.notify_channels as string[])
    : ["inapp"];

  const title =
    severity === "resolved"
      ? `Resolved: ${metricKey}`
      : `${severity === "crit" ? "CRITICAL" : "Warning"}: ${metricKey}`;

  if (channels.includes("inapp")) {
    try {
      await notifyRoles(["operations"], {
        type: "ops_alert",
        title,
        message,
        data: { metric_key: metricKey, source, severity },
      });
    } catch (e) {
      log.warn(`[ops] in-app alert notify failed: ${rootCauseMessage(e)}`);
    }
  }

  // Email is opt-in per rule AND requires a recipient. Without OPS_ALERT_EMAIL
  // there is nowhere to send, and silently doing nothing is better than
  // throwing on every tick.
  const recipient = process.env.OPS_ALERT_EMAIL;
  if (channels.includes("email") && recipient) {
    try {
      const { getMailer } = await import("@/lib/email/mailer");
      await getMailer().sendMail({
        to: recipient,
        subject: `[iTarang Ops] ${title}`,
        text: `${message}\n\nMetric: ${metricKey}\nSource: ${source}\n\nSee /operations/alerts.`,
      });
    } catch (e) {
      log.warn(`[ops] alert email failed: ${rootCauseMessage(e)}`);
    }
  }
}
