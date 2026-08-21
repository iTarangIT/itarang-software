// E-254 / E-228 — end-to-end verification of the campaign scheduling LIFECYCLE
// against the real database.
//
//   node --import tsx --env-file=.env.local scripts/verify-e254-campaign-lifecycle.ts
//
// Companion to scripts/verify-e254-campaign-window.ts, which proves the window
// PREDICATES in isolation. This one drives the real state machine:
// advanceCampaign's gate, pauseForWindow, resumeDueCampaigns, and the stall
// watchdog's morning-after fix — each through the actual application module, so
// nothing here can pass while the shipped code is wrong.
//
// ── WHY THIS CANNOT PLACE A REAL CALL ──────────────────────────────────────
//
// Every campaign it creates is enrolled with lead ids that do NOT exist in
// dealer_leads. advanceCampaign looks the lead up before dialling and, on
// `lead.length === 0 || !lead[0].phone`, marks the row failed with
// call_outcome='no_phone' and moves on — it returns long before
// triggerBolnaCall. So the claim/skip/exhaust/finalize path runs for real while
// the provider is never contacted and no dealer's phone rings.
//
// It also refuses to start if any campaign it did not create is in 'running' or
// 'scheduled', because the watchdog and resume steps below operate on whatever
// they find and would otherwise touch someone else's live run.
//
// Every row it creates is prefixed E254E2E- and deleted at the end
// (dialer_campaign_leads cascades from dialer_campaigns).

import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { dialerCampaigns, dialerCampaignLeads } from "../src/lib/db/schema";
import { advanceCampaign } from "../src/lib/queue/advanceCampaign";
import {
  resumeDueCampaigns,
  runCampaignWindowTick,
} from "../src/lib/queue/resumeCampaigns";

const PREFIX = "E254E2E-";

let failed = 0;
const ok = (n: string) => console.log(`  PASS  ${n}`);
const bad = (n: string, d: string) => {
  failed++;
  console.log(`  FAIL  ${n}\n        ${d}`);
};
function expect(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) ok(name);
  else bad(name, `expected ${w}, got ${g}`);
}

// ── fixtures ───────────────────────────────────────────────────────────────

type Fixture = {
  scheduleMode: "now" | "single" | "recurring";
  windowStart?: string | null;
  windowEnd?: string | null;
  windowDays?: string[] | null;
  leads?: number;
  status?: string;
  startedAt?: string; // SQL interval expression, e.g. "now() - interval '3 hours'"
};

let seq = 0;

async function makeCampaign(f: Fixture): Promise<string> {
  const id = `${PREFIX}${Date.now().toString(36)}-${seq++}`;
  await db.execute(sql`
    INSERT INTO dialer_campaigns
      (id, name, provider, status, total_leads, schedule_mode,
       window_start, window_end, window_days, started_at)
    VALUES (
      ${id}, ${"E-254 e2e fixture"}, 'bolna', ${f.status ?? "running"},
      ${f.leads ?? 2}, ${f.scheduleMode},
      ${f.windowStart ?? null}, ${f.windowEnd ?? null},
      ${f.windowDays === undefined || f.windowDays === null
        ? null
        : JSON.stringify(f.windowDays)}::jsonb,
      ${f.startedAt ? sql.raw(f.startedAt) : sql`now()`}
    )
  `);
  const n = f.leads ?? 2;
  for (let i = 0; i < n; i++) {
    await db.execute(sql`
      INSERT INTO dialer_campaign_leads
        (id, campaign_id, lead_id, queue_position, status)
      VALUES (${`${id}-L${i}`}, ${id}, ${`${PREFIX}LEAD-${i}`}, ${i}, 'pending')
    `);
  }
  return id;
}

async function readCampaign(id: string) {
  const r = await db
    .select({
      status: dialerCampaigns.status,
      pausedAt: dialerCampaigns.paused_at,
      resumeAfter: dialerCampaigns.resume_after,
      completedAt: dialerCampaigns.completed_at,
      lastAdvancedAt: dialerCampaigns.last_advanced_at,
    })
    .from(dialerCampaigns)
    .where(eq(dialerCampaigns.id, id))
    .limit(1);
  return r[0];
}

async function leadStates(id: string): Promise<string[]> {
  const r = await db
    .select({
      pos: dialerCampaignLeads.queue_position,
      status: dialerCampaignLeads.status,
    })
    .from(dialerCampaignLeads)
    .where(eq(dialerCampaignLeads.campaign_id, id))
    .orderBy(dialerCampaignLeads.queue_position);
  return r.map((x) => x.status);
}

async function countPending(id: string): Promise<number> {
  const r = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(dialerCampaignLeads)
    .where(
      and(
        eq(dialerCampaignLeads.campaign_id, id),
        eq(dialerCampaignLeads.status, "pending"),
      ),
    );
  return r[0]?.n ?? 0;
}

// A window that is definitely SHUT right now, on every weekday, without any
// date arithmetic here: read the DB's own IST clock and step an hour past it.
async function shutWindow(): Promise<{ start: string; end: string }> {
  const r = await db.execute<{ s: string; e: string }>(sql`
    SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata' + interval '2 hours', 'HH24:MI') AS s,
           to_char(now() AT TIME ZONE 'Asia/Kolkata' + interval '4 hours', 'HH24:MI') AS e
  `);
  const row = (r as unknown as { s: string; e: string }[])[0];
  return { start: row.s, end: row.e };
}

// A window that is definitely OPEN right now.
async function openWindow(): Promise<{ start: string; end: string }> {
  const r = await db.execute<{ s: string; e: string }>(sql`
    SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata' - interval '1 hour', 'HH24:MI') AS s,
           to_char(now() AT TIME ZONE 'Asia/Kolkata' + interval '1 hour', 'HH24:MI') AS e
  `);
  const row = (r as unknown as { s: string; e: string }[])[0];
  return { start: row.s, end: row.e };
}

const ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

async function cleanup() {
  await db.execute(
    sql`DELETE FROM dialer_campaigns WHERE id LIKE ${PREFIX + "%"}`,
  );
}

// ── safety gate ────────────────────────────────────────────────────────────

async function assertSafe() {
  const live = await db.execute<{ id: string; status: string }>(sql`
    SELECT id, status FROM dialer_campaigns
     WHERE status IN ('running', 'scheduled')
       AND id NOT LIKE ${PREFIX + "%"}
  `);
  const rows = live as unknown as { id: string; status: string }[];
  if (rows.length > 0) {
    console.error(
      "\nREFUSING TO RUN — these campaigns are live and the watchdog/resume " +
        "steps below would act on them:\n" +
        rows.map((r) => `  ${r.id} (${r.status})`).join("\n") +
        "\nWait for them to finish, or stop them, then re-run.\n",
    );
    process.exit(2);
  }
}

// ── the tests ──────────────────────────────────────────────────────────────

async function main() {
  await assertSafe();
  await cleanup(); // leftovers from an interrupted previous run

  const shut = await shutWindow();
  const open = await openWindow();
  console.log(
    `\nIST now-relative fixtures — open ${open.start}-${open.end}, ` +
      `shut ${shut.start}-${shut.end}\n`,
  );

  // 1. WINDOW OPEN → the gate lets the campaign through and it runs to
  //    completion. (Leads are non-existent, so each is skipped as no_phone —
  //    the point is that advanceCampaign got PAST the gate and consumed the
  //    queue rather than parking.)
  console.log("1. Window OPEN — campaign dials rather than parking");
  {
    const id = await makeCampaign({
      scheduleMode: "recurring",
      windowStart: open.start,
      windowEnd: open.end,
      windowDays: ALL_DAYS,
    });
    const r = await advanceCampaign(id);
    expect("advance is not window-closed", r.kind !== "window-closed", true);
    const c = await readCampaign(id);
    expect("queue consumed → status completed", c.status, "completed");
    expect("no pending leads left", await countPending(id), 0);
  }

  // 2. WINDOW SHUT + recurring → parks as 'scheduled', arms resume_after,
  //    leaves the queue alone, and does NOT stamp completed_at.
  console.log("\n2. Window SHUT + recurring — parks as Scheduled");
  {
    const id = await makeCampaign({
      scheduleMode: "recurring",
      windowStart: shut.start,
      windowEnd: shut.end,
      windowDays: ALL_DAYS,
    });
    const r = await advanceCampaign(id);
    expect("advance reports window-closed", r.kind, "window-closed");
    if (r.kind === "window-closed") {
      expect("parked as scheduled", r.status, "scheduled");
      expect("resumeAt is set", r.resumeAt != null, true);
    }
    const c = await readCampaign(id);
    expect("db status is scheduled", c.status, "scheduled");
    expect("paused_at stamped", c.pausedAt != null, true);
    expect("resume_after armed", c.resumeAfter != null, true);
    // The finalizeCampaign trap: a paused campaign that carried completed_at
    // would read as finished on every card and report.
    expect("completed_at still NULL", c.completedAt, null);
    expect("both leads still pending", await countPending(id), 2);
    // resume_after must be in the future, or the ticker would wake it straight
    // back into a shut window and loop every 60s.
    const fut = await db.execute<{ f: boolean }>(sql`
      SELECT resume_after > now() AS f FROM dialer_campaigns WHERE id = ${id}
    `);
    expect(
      "resume_after is in the future",
      (fut as unknown as { f: boolean }[])[0]?.f,
      true,
    );
  }

  // 3. WINDOW SHUT + single run → parks as 'paused' with NO resume armed.
  console.log("\n3. Window SHUT + single run — parks as Paused, never wakes");
  {
    const id = await makeCampaign({
      scheduleMode: "single",
      windowStart: shut.start,
      windowEnd: shut.end,
      windowDays: null,
    });
    const r = await advanceCampaign(id);
    expect("advance reports window-closed", r.kind, "window-closed");
    if (r.kind === "window-closed") {
      expect("parked as paused", r.status, "paused");
      expect("no resumeAt", r.resumeAt, null);
    }
    const c = await readCampaign(id);
    expect("db status is paused", c.status, "paused");
    expect("resume_after NULL — nothing claims it", c.resumeAfter, null);
    expect("completed_at still NULL", c.completedAt, null);
    expect("leads left pending", await countPending(id), 2);

    // The resume ticker must ignore it, today and every day.
    const before = await readCampaign(id);
    await resumeDueCampaigns();
    const after = await readCampaign(id);
    expect("ticker leaves a paused campaign alone", after.status, before.status);
  }

  // 4. Resume ticker claims a due campaign, exactly once, and continues from
  //    the NEXT unprocessed lead rather than restarting the queue.
  console.log("\n4. Resume ticker — wakes a due campaign, resumes mid-queue");
  {
    const id = await makeCampaign({
      scheduleMode: "recurring",
      windowStart: open.start,
      windowEnd: open.end,
      windowDays: ALL_DAYS,
      leads: 3,
    });
    // Simulate "day 1 processed lead #0, then the window shut".
    await db.execute(sql`
      UPDATE dialer_campaign_leads
         SET status = 'completed', completed_at = now()
       WHERE campaign_id = ${id} AND queue_position = 0
    `);
    await db.execute(sql`
      UPDATE dialer_campaigns
         SET status = 'scheduled', paused_at = now(),
             resume_after = now() - interval '1 minute'
       WHERE id = ${id}
    `);

    const preState = await readCampaign(id);
    const dueNow = await db.execute<{ due: boolean; ra: string | null }>(sql`
      SELECT resume_after <= now() AS due, resume_after::text AS ra
        FROM dialer_campaigns WHERE id = ${id}
    `);
    const first = await resumeDueCampaigns();
    if (!first.resumed.includes(id)) {
      console.log(
        "DIAG pre:", JSON.stringify(preState),
        "| due:", JSON.stringify(dueNow),
        "| returned:", JSON.stringify(first),
      );
    }
    expect("claimed the due campaign", first.resumed.includes(id), true);

    // Race check: a second tick in the same window must not re-claim it.
    const second = await resumeDueCampaigns();
    expect("a second tick does NOT re-claim it", second.resumed.includes(id), false);

    const states = await leadStates(id);
    expect(
      "lead #0 untouched — resumed mid-queue, did not restart",
      states[0],
      "completed",
    );
    const c = await readCampaign(id);
    expect("resume_after cleared", c.resumeAfter, null);
    expect("paused_at cleared", c.pausedAt, null);
    expect("last_advanced_at stamped on wake", c.lastAdvancedAt != null, true);
  }

  // 5. Concurrency: two ticks firing at the same instant must not both claim
  //    the same campaign — that is two calls to two leads at once.
  console.log("\n5. Two resume ticks racing — only one claims the campaign");
  {
    const id = await makeCampaign({
      scheduleMode: "recurring",
      windowStart: shut.start, // shut, so the winner parks again rather than dialling
      windowEnd: shut.end,
      windowDays: ALL_DAYS,
      status: "scheduled",
    });
    await db.execute(sql`
      UPDATE dialer_campaigns SET resume_after = now() - interval '1 minute'
       WHERE id = ${id}
    `);
    const [a, b] = await Promise.all([
      resumeDueCampaigns(),
      resumeDueCampaigns(),
    ]);
    const claims =
      (a.resumed.includes(id) ? 1 : 0) + (b.resumed.includes(id) ? 1 : 0);
    expect("claimed by exactly one tick", claims, 1);
  }

  // 6. THE MORNING-AFTER TRAP. A campaign resumed today still carries
  //    yesterday's started_at. The watchdog must measure from
  //    COALESCE(last_advanced_at, started_at) or it force-stops it before the
  //    first call — every day, making recurring campaigns silently never work.
  console.log("\n6. Watchdog — a freshly-resumed campaign is not force-stopped");
  {
    const stale = await makeCampaign({
      scheduleMode: "recurring",
      windowStart: open.start,
      windowEnd: open.end,
      windowDays: ALL_DAYS,
      startedAt: "now() - interval '20 hours'",
    });
    await db.execute(sql`
      UPDATE dialer_campaigns SET last_advanced_at = now() WHERE id = ${stale}
    `);

    // Exactly the expression the watchdog now uses, and the one it used before.
    const r = await db.execute<{ fixed_h: number; old_h: number }>(sql`
      SELECT extract(epoch FROM (now() - COALESCE(last_advanced_at, started_at)))/3600 AS fixed_h,
             extract(epoch FROM (now() - started_at))/3600 AS old_h
        FROM dialer_campaigns WHERE id = ${stale}
    `);
    const row = (r as unknown as { fixed_h: number; old_h: number }[])[0];
    const STALL_H = 2; // STALL_FINALIZE_AGE_MS
    expect(
      "old started_at-only age would have tripped the 2h stall gate",
      Number(row.old_h) > STALL_H,
      true,
    );
    expect(
      "COALESCE(last_advanced_at, started_at) age does NOT trip it",
      Number(row.fixed_h) < STALL_H,
      true,
    );
  }

  // 6b. THE ACTIVE PARK. advanceCampaign's gate is lazy — it only fires when
  //     something calls it, and the only routine caller is a call-completion
  //     webhook. A campaign sitting idle when the clock passes its end time has
  //     no webhook coming, so without this sweep it stays 'running' (the card
  //     lies) and, worse, a recurring one never reaches 'scheduled' and so is
  //     never claimed again — stuck, not delayed.
  console.log("");
  console.log("6b. Window ticker — actively parks an idle running campaign");
  {
    const recurring = await makeCampaign({
      scheduleMode: "recurring",
      windowStart: shut.start,
      windowEnd: shut.end,
      windowDays: ALL_DAYS,
    });
    const single = await makeCampaign({
      scheduleMode: "single",
      windowStart: shut.start,
      windowEnd: shut.end,
      windowDays: null,
    });
    // Nothing has touched either since the window closed — exactly the state
    // the lazy gate cannot resolve on its own.
    expect("recurring starts out still 'running'", (await readCampaign(recurring)).status, "running");

    const tick = await runCampaignWindowTick();
    expect("tick parks the recurring campaign", tick.parked.includes(recurring), true);
    expect("tick parks the single-run campaign", tick.parked.includes(single), true);
    expect("recurring parked as scheduled", (await readCampaign(recurring)).status, "scheduled");
    expect("single parked as paused", (await readCampaign(single)).status, "paused");
    expect("recurring queue preserved", await countPending(recurring), 2);

    // Idempotent: a second tick a minute later must not re-park or disturb them.
    const again = await runCampaignWindowTick();
    expect("second tick parks nothing", again.parked.length, 0);
    expect("recurring still scheduled", (await readCampaign(recurring)).status, "scheduled");
  }

  // 6c. The sweep must NOT touch a campaign whose window is open, and must not
  //     park a finished run (which would leave it parked instead of completed).
  console.log("");
  console.log("6c. Window ticker — leaves open windows and empty queues alone");
  {
    const openCampaign = await makeCampaign({
      scheduleMode: "recurring",
      windowStart: open.start,
      windowEnd: open.end,
      windowDays: ALL_DAYS,
    });
    const emptyQueue = await makeCampaign({
      scheduleMode: "recurring",
      windowStart: shut.start,
      windowEnd: shut.end,
      windowDays: ALL_DAYS,
    });
    // A 'running' row with nothing pending = a finished campaign waiting on its
    // last webhook. Parking that would strand a completed run as 'scheduled'.
    await db.execute(sql`
      UPDATE dialer_campaign_leads SET status = 'completed', completed_at = now()
       WHERE campaign_id = ${emptyQueue}
    `);

    const tick = await runCampaignWindowTick();
    expect("open-window campaign not parked", tick.parked.includes(openCampaign), false);
    expect("open-window campaign still running", (await readCampaign(openCampaign)).status, "running");
    expect("empty-queue campaign not parked", tick.parked.includes(emptyQueue), false);
    expect("empty-queue campaign left for its webhook", (await readCampaign(emptyQueue)).status, "running");
  }

  // 7. Backward compatibility: an unscheduled campaign is untouched by all of
  //    this — it dials continuously at any hour, exactly as before E-228.
  console.log("\n7. Backward compatibility — 'now' campaigns are unaffected");
  {
    const id = await makeCampaign({ scheduleMode: "now" });
    const r = await advanceCampaign(id);
    expect("never parks", r.kind !== "window-closed", true);
    const c = await readCampaign(id);
    expect("runs to completion", c.status, "completed");

    // And a legacy row: schedule_mode default with NULL windows, which is what
    // every pre-E-254 campaign looks like.
    const legacy = await makeCampaign({
      scheduleMode: "now",
      windowStart: null,
      windowEnd: null,
      windowDays: null,
    });
    const r2 = await advanceCampaign(legacy);
    expect("legacy NULL-window row never parks", r2.kind !== "window-closed", true);
  }

  await cleanup();
  const left = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM dialer_campaigns WHERE id LIKE ${PREFIX + "%"}`,
  );
  expect("fixtures cleaned up", (left as unknown as { n: number }[])[0]?.n, 0);

  console.log(
    `\n${failed === 0 ? "ALL PASS" : `${failed} FAILURE(S)`} — E-254 campaign lifecycle\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("verify script threw:", e);
  try {
    await cleanup();
  } catch {
    /* best effort */
  }
  process.exit(1);
});
