import { redirect } from "next/navigation";
import { desc, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { securityEvents } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import SecurityNavTabs from "../_components/SecurityNavTabs";
import LiveStatCards from "../_components/LiveStatCards";
import LiveAttacksTable, { type EventForUi } from "../_components/LiveAttacksTable";
import AutoRefresh from "../_components/AutoRefresh";

export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["it"]);

export default async function LiveAttacksPage() {
  const user = await requireAuth();
  // Wrong role → bounce to "/", which middleware forwards to that role’s own
  // dashboard. Sending them to /login instead would read as a forced logout.
  if (!ALLOWED_ROLES.has(user.role)) redirect("/");

  // Time windows are computed in SQL (now() - interval) so the component render
  // stays pure — no Date.now() in the render body.
  const rows = await db
    .select()
    .from(securityEvents)
    .where(gte(securityEvents.occurred_at, sql`now() - interval '14 days'`))
    .orderBy(desc(securityEvents.occurred_at))
    .limit(300);

  const events: EventForUi[] = rows.map((r) => ({
    id: r.id,
    occurred_at: r.occurred_at?.toISOString() ?? null,
    event_type: r.event_type,
    severity: r.severity,
    action: r.action,
    ip: r.ip,
    actor_role: r.actor_role,
    actor_user_id: r.actor_user_id,
    method: r.method,
    path: r.path,
    query: r.query,
    user_agent: r.user_agent,
    matched_rule: r.matched_rule,
    evidence: r.evidence as Record<string, unknown> | null,
    status: r.status,
  }));

  const [agg] = await db
    .select({
      critical: sql<number>`cast(count(*) filter (where ${securityEvents.severity} = 'critical') as int)`,
      high: sql<number>`cast(count(*) filter (where ${securityEvents.severity} = 'high') as int)`,
      blocked: sql<number>`cast(count(*) filter (where ${securityEvents.action} = 'blocked') as int)`,
      total: sql<number>`cast(count(*) as int)`,
    })
    .from(securityEvents)
    .where(gte(securityEvents.occurred_at, sql`now() - interval '24 hours'`));
  const counts = {
    critical: agg?.critical ?? 0,
    high: agg?.high ?? 0,
    blocked: agg?.blocked ?? 0,
    total: agg?.total ?? 0,
  };

  const enabled = process.env.SECURITY_DETECTION_ENABLED === "1";

  return (
    <div className="space-y-6">
      <AutoRefresh />
      <div>
        <h1 className="text-2xl font-semibold">Security Risk</h1>
        <p className="text-sm text-slate-500 mt-1">
          Attacks caught in real time by the middleware detection layer — injection (SQL, NoSQL,
          command, XSS, XXE, JNDI), path traversal, SSRF, scanner tools, sensitive-file probing,
          and volumetric attacks (request floods, path enumeration, auth brute-force).
        </p>
      </div>

      <SecurityNavTabs />

      {!enabled ? (
        <div className="border border-amber-200 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200 dark:border-amber-900 text-sm rounded-lg p-3.5">
          <b>Live detection is off.</b> It’s disabled by default because it hooks into request
          handling and can block requests. To turn it on, set{" "}
          <code className="font-mono">SECURITY_DETECTION_ENABLED=1</code> and{" "}
          <code className="font-mono">SECURITY_INTERNAL_SECRET=&lt;random&gt;</code> in your
          environment, then restart. Past events (if any) are still shown below.
        </div>
      ) : null}

      <LiveStatCards counts={counts} />
      <LiveAttacksTable events={events} />
    </div>
  );
}
