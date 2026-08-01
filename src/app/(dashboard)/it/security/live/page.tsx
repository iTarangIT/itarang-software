import { redirect } from "next/navigation";
import { and, desc, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { securityEvents } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import SecurityNavTabs from "../_components/SecurityNavTabs";
import LiveStatCards from "../_components/LiveStatCards";
import LiveAttacksTable, { type EventForUi, type IpProfile } from "../_components/LiveAttacksTable";
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

  // Per-IP history over 30 days. One event says what a sender tried once; this
  // says whether the same sender has been at it for a week — which is usually
  // what decides between "ignore" and "block it upstream". Computed here rather
  // than frozen into each row's evidence so it stays current as events arrive.
  const ipRows = await db
    .select({
      ip: securityEvents.ip,
      events: sql<number>`cast(count(*) as int)`,
      blocked: sql<number>`cast(count(*) filter (where ${securityEvents.action} = 'blocked') as int)`,
      firstSeen: sql<string>`min(${securityEvents.occurred_at})::text`,
      lastSeen: sql<string>`max(${securityEvents.occurred_at})::text`,
      types: sql<string[]>`array_agg(distinct ${securityEvents.event_type})`,
      paths: sql<number>`cast(count(distinct ${securityEvents.path}) as int)`,
    })
    .from(securityEvents)
    .where(
      and(
        isNotNull(securityEvents.ip),
        gte(securityEvents.occurred_at, sql`now() - interval '30 days'`),
      ),
    )
    .groupBy(securityEvents.ip);

  const ipProfiles: Record<string, IpProfile> = {};
  for (const r of ipRows) {
    if (!r.ip) continue;
    ipProfiles[r.ip] = {
      events: r.events ?? 0,
      blocked: r.blocked ?? 0,
      firstSeen: r.firstSeen ?? null,
      lastSeen: r.lastSeen ?? null,
      types: r.types ?? [],
      paths: r.paths ?? 0,
    };
  }

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
  // Monitor mode downgrades every block to a log, so it also disables banning —
  // stated plainly here, because "detection is on" and "attacks are actually
  // being stopped" are two different things and the difference matters.
  const monitorOnly = process.env.SECURITY_DETECTION_MODE === "monitor";
  const autoBlock = enabled && !monitorOnly && process.env.SECURITY_AUTO_BLOCK !== "0";
  const banStrikes = Number(process.env.SECURITY_AUTO_BLOCK_STRIKES) > 0
    ? Number(process.env.SECURITY_AUTO_BLOCK_STRIKES)
    : 3;
  const banMinutes = Number(process.env.SECURITY_AUTO_BLOCK_MINUTES) > 0
    ? Number(process.env.SECURITY_AUTO_BLOCK_MINUTES)
    : 30;

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
      ) : autoBlock ? (
        <div className="border border-emerald-200 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200 dark:border-emerald-900 text-sm rounded-lg p-3.5">
          <b>Attacks are being blocked.</b> A request carrying a recognised attack payload is
          refused with 403 and never reaches the application. After{" "}
          <b>{banStrikes} blocked attempts</b> (or a single critical one) the source IP is banned
          for <b>{banMinutes} minutes</b> — doubling on each repeat, up to 24 hours — and every
          request from it is refused until the ban lifts. Only public internet addresses are ever
          banned.
        </div>
      ) : (
        <div className="border border-amber-200 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200 dark:border-amber-900 text-sm rounded-lg p-3.5">
          <b>Detection is on, but blocking is off.</b>{" "}
          {monitorOnly
            ? "SECURITY_DETECTION_MODE=monitor downgrades every block to a log entry."
            : "SECURITY_AUTO_BLOCK=0 disables the automatic IP ban."}{" "}
          Attacks below were recorded and allowed through.
        </div>
      )}

      <LiveStatCards counts={counts} />
      <LiveAttacksTable events={events} ipProfiles={ipProfiles} />
    </div>
  );
}
