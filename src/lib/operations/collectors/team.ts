/**
 * Team usage — licence and capacity monitoring.
 *
 * There is no sessions, logins, last_seen or page_views table in this codebase,
 * and `users` has no last_login column. The only record of who signed in and
 * when lives in Supabase's own auth schema, which is not in our Postgres. So
 * this asks Supabase.
 *
 * SCOPE IS DELIBERATELY AGGREGATE. The plan sketched "one sample per user", and
 * this does NOT do that. Two reasons:
 *
 *   1. registry.ts declares only aggregate team metrics — active_users_24h/7d/
 *      30d, never_logged_in, inactive_30d, actions_24h. A per-user sample would
 *      have no MetricDef, so nothing could render or alert on it.
 *   2. Writing one timestamped row per person per collection turns
 *      ops_metric_samples into a per-employee activity log with 30 days of
 *      history. That is a different product from the one this plan describes
 *      ("capacity and licence monitoring, not per-person surveillance"), and it
 *      is not one you can quietly opt into on the tech team's dashboard.
 *
 * The per-person breakdown the page shows (top actors) is computed live from
 * audit_logs at render time and never persisted as a time series.
 *
 * ---------------------------------------------------------------------------
 * E-214 UPDATE — what changed, and what did not.
 *
 * A per-person usage record now EXISTS, in user_login_events and
 * user_activity_sessions, read only by /operations/usage. So reason 2's first
 * clause no longer describes the whole system, and pretending otherwise would
 * make this comment a lie.
 *
 * REASON 1 STILL HOLDS EXACTLY AS WRITTEN, and this collector still obeys it:
 * no per-person row is written to ops_metric_samples or ops_daily_snapshots, by
 * either collector. The permanent, never-pruned record stays aggregate-only.
 * That is the invariant — not "we don't measure people", but "the metric series
 * is not where people are measured". A test pins the sample count and source.
 *
 * REASON 2's SECOND CLAUSE — "not one you can quietly opt into" — is the part
 * that was honoured rather than deleted. The per-person tables carry a stated
 * retention (90 days logins / 30 days sessions, pruned by runDailySnapshot),
 * store no IP, user-agent or page path, sit behind their own role set
 * (USAGE_ANALYTICS_ROLES, separate from OPERATIONS_ROLES so widening one does
 * not widen the other), and the heartbeat half did not ship until the staff
 * notice in docs/OPERATIONS_RUNBOOK.md had gone out. The scope moved; the
 * principle did not.
 *
 * This collector is unchanged and stays what it always was: licence and capacity.
 * ---------------------------------------------------------------------------
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { unavailableText } from "@/lib/operations/errors";
import { supabaseAdmin } from "@/lib/supabase/admin";

import type { CollectedSample, OpsCollector } from "./types";
import { MINUTE } from "./types";

const SOURCE = "team:all";

/** Supabase caps perPage at 1000; page until short. */
const PAGE_SIZE = 1000;
const MAX_PAGES = 10;

interface SignInSummary {
  total: number;
  active24h: number;
  active7d: number;
  active30d: number;
  neverSignedIn: number;
  inactive30d: number;
}

/**
 * Walk every Supabase auth user and bucket them by last_sign_in_at.
 *
 * listUsers() is paginated and returns the whole user object; only the
 * timestamp is read, and nothing per-user leaves this function.
 */
async function summariseSignIns(): Promise<SignInSummary> {
  const now = Date.now();
  const summary: SignInSummary = {
    total: 0,
    active24h: 0,
    active7d: 0,
    active30d: 0,
    neverSignedIn: 0,
    inactive30d: 0,
  };

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: PAGE_SIZE,
    });
    if (error) throw new Error(`Supabase listUsers failed: ${error.message}`);

    const users = data?.users ?? [];
    for (const user of users) {
      summary.total += 1;

      const raw = user.last_sign_in_at;
      const at = raw ? Date.parse(raw) : NaN;
      if (!Number.isFinite(at)) {
        // Provisioned and never used. Each one is a live credential nobody is
        // watching, which is why it has its own metric rather than being
        // folded into "inactive".
        summary.neverSignedIn += 1;
        continue;
      }

      const ageDays = (now - at) / 86_400_000;
      if (ageDays <= 1) summary.active24h += 1;
      if (ageDays <= 7) summary.active7d += 1;
      if (ageDays <= 30) summary.active30d += 1;
      else summary.inactive30d += 1;
    }

    // A short page is the last page.
    if (users.length < PAGE_SIZE) break;
  }

  return summary;
}

export const teamCollector: OpsCollector = {
  id: "team.usage",
  label: "Team activity & licence usage",
  // Sign-in buckets shift on a daily timescale; this is an external API call
  // and there is nothing to gain from asking more often.
  intervalMs: 60 * MINUTE,
  timeoutMs: 25_000,

  async run(): Promise<CollectedSample[]> {
    // Two independent halves. audit_logs is ours and always readable; the
    // Supabase call is the part that can fail — a missing service-role key, a
    // decommissioned project, plain DNS. `allSettled`, not `all`: a Supabase
    // outage must cost us the sign-in buckets and nothing else, exactly as a
    // failing collector fails only itself (see ../runner.ts).
    const [actionsResult, signInResult] = await Promise.allSettled([
      db.execute(sql`
        SELECT COUNT(*)::int AS n FROM audit_logs
        WHERE created_at > NOW() - INTERVAL '24 hours'
      `) as unknown as Promise<Array<Record<string, unknown>>>,
      summariseSignIns(),
    ]);

    const samples: CollectedSample[] = [];

    if (actionsResult.status === "fulfilled") {
      const actions = Number(actionsResult.value?.[0]?.n ?? 0);
      samples.push({
        metric_key: "team.actions_24h",
        source: SOURCE,
        value_num: Number.isFinite(actions) ? actions : 0,
      });
    }

    if (signInResult.status === "fulfilled") {
      const signIns = signInResult.value;
      samples.push(
        {
          metric_key: "team.active_users_24h",
          source: SOURCE,
          value_num: signIns.active24h,
          meta: { total_accounts: signIns.total },
        },
        { metric_key: "team.active_users_7d", source: SOURCE, value_num: signIns.active7d },
        { metric_key: "team.active_users_30d", source: SOURCE, value_num: signIns.active30d },
        {
          metric_key: "team.never_logged_in",
          source: SOURCE,
          value_num: signIns.neverSignedIn,
        },
        { metric_key: "team.inactive_30d", source: SOURCE, value_num: signIns.inactive30d },
      );
    } else {
      // A text sample rather than silence. Without a row here the page shows an
      // empty licence panel, which reads as "nobody has logged in" — the exact
      // opposite of "we could not ask".
      samples.push({
        metric_key: "team.active_users_24h",
        source: SOURCE,
        value_num: null,
        value_text: unavailableText(signInResult.reason, "supabase unavailable"),
      });
    }

    // Both halves down means the collector genuinely failed; let the runner
    // record it as such rather than reporting an empty success.
    if (samples.length === 0) {
      throw new Error(
        `team collector failed: ${unavailableText(signInResult.status === "rejected" ? signInResult.reason : actionsResult)}`,
      );
    }

    return samples;
  },
};
