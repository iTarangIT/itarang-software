/**
 * li_action_log — every provider call writes one row, and the daily caps are
 * COUNTED from it (doc §6.3), so a restart can never exceed a cap.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { liActionLog } from "@/lib/db/schema";

import { istDayStart, type TodayCounts } from "./pacing";

export type LiAction =
  | "invite"
  | "message"
  | "reply"
  | "poll"
  | "health"
  | "search"
  | "refused"
  | "pause"
  | "resume"
  | "resolve"
  | "approve"
  | "connect"
  | "meeting"; // E-398: Sales Head marked / cleared "meeting scheduled" (ok = marked)

type Db = typeof db;

export async function logAction(
  row: {
    accountId?: string | null;
    action: LiAction;
    ok: boolean;
    prospectId?: string | null;
    campaignId?: string | null;
    detail?: string | null;
    actorId?: string | null;
  },
  conn: Db = db,
): Promise<void> {
  await conn.insert(liActionLog).values({
    account_id: row.accountId ?? null,
    action: row.action,
    ok: row.ok,
    prospect_id: row.prospectId ?? null,
    campaign_id: row.campaignId ?? null,
    detail: row.detail ? row.detail.slice(0, 2000) : null,
    actor_id: row.actorId ?? null,
  });
}

/** Successful invites / messages (campaign + inbox replies) since IST midnight. */
export async function todayCounts(accountId: string, now: Date, conn: Db = db): Promise<TodayCounts> {
  const rows = await conn
    .select({ action: liActionLog.action, n: sql<number>`count(*)::int` })
    .from(liActionLog)
    .where(
      and(
        eq(liActionLog.account_id, accountId),
        eq(liActionLog.ok, true),
        inArray(liActionLog.action, ["invite", "message", "reply"]),
        gte(liActionLog.at, istDayStart(now)),
      ),
    )
    .groupBy(liActionLog.action);
  const by = Object.fromEntries(rows.map((r) => [r.action, Number(r.n)]));
  return { invites: by.invite ?? 0, messages: (by.message ?? 0) + (by.reply ?? 0) };
}

/** The latest successful send from this account — the random gap runs from it. */
export async function lastSendAt(accountId: string, conn: Db = db): Promise<{ at: Date; id: number } | null> {
  const [row] = await conn
    .select({ at: liActionLog.at, id: liActionLog.id })
    .from(liActionLog)
    .where(
      and(
        eq(liActionLog.account_id, accountId),
        eq(liActionLog.ok, true),
        inArray(liActionLog.action, ["invite", "message", "reply"]),
      ),
    )
    .orderBy(desc(liActionLog.at))
    .limit(1);
  return row ?? null;
}

export async function recentLog(accountId: string | null, limit = 100) {
  const q = db.select().from(liActionLog);
  const rows = await (accountId ? q.where(eq(liActionLog.account_id, accountId)) : q)
    .orderBy(desc(liActionLog.at))
    .limit(Math.min(limit, 500));
  return rows;
}
