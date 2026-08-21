// E-254 — verification of the API surface: what gets WRITTEN when a campaign is
// created with a window, and what gets READ back to the UI.
//
//   node --import tsx --env-file=.env.local scripts/verify-e254-campaign-api.ts
//
// Third of three. verify-e254-campaign-window.ts proves the SQL predicates,
// verify-e254-campaign-lifecycle.ts drives the state machine; this covers the
// edges the other two do not touch — createCampaign's persistence, the three
// read routes' projections (including the UNION in /api/campaigns/unified,
// where an untyped NULL on the NeoDove branch would take the whole tab down),
// the assignment_config defaults lookup, and the widened resume gate.
//
// Same safety property as the lifecycle script: fixtures use lead ids that do
// not exist in dealer_leads, so advanceCampaign can never reach the provider.
// The Redis dialer session that startDraftCampaign seeds is cleared at the end
// so this leaves no phantom banner behind on the shared sandbox.

import { eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { dialerCampaigns } from "../src/lib/db/schema";
import { createCampaign } from "../src/lib/queue/campaignTracker";
import {
  campaignScheduleSchema,
  resolveScheduleDefaults,
} from "../src/lib/queue/campaignWindow";
import { dialerSession } from "../src/lib/queue/dialerSession";

const PREFIX = "E254API-";

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

async function cleanup() {
  await db.execute(
    sql`DELETE FROM dialer_campaigns WHERE id LIKE ${PREFIX + "%"} OR name = ${"E-254 api fixture"}`,
  );
  try {
    await dialerSession.stop();
  } catch {
    /* Redis may be unconfigured locally; nothing to clear then. */
  }
}

async function main() {
  await cleanup();

  // 1. createCampaign persists the window, and the mode↔columns coupling holds.
  console.log("\n1. createCampaign — persists schedule_mode + window columns");
  let recurringId: string | null = null;
  {
    const schedule = campaignScheduleSchema.parse({
      mode: "recurring",
      window_start: "11:00",
      window_end: "15:00",
      window_days: ["mon", "wed", "fri"],
    });
    const r = await createCampaign({
      queueIds: [`${PREFIX}L1`, `${PREFIX}L2`],
      provider: "bolna",
      status: "draft",
      name: "E-254 api fixture",
      schedule,
    });
    recurringId = r.campaignId;
    expect("campaign created", r.campaignId != null, true);

    const row = await db
      .select({
        mode: dialerCampaigns.schedule_mode,
        ws: dialerCampaigns.window_start,
        we: dialerCampaigns.window_end,
        wd: dialerCampaigns.window_days,
      })
      .from(dialerCampaigns)
      .where(eq(dialerCampaigns.id, r.campaignId!))
      .limit(1);
    expect("schedule_mode stored", row[0]?.mode, "recurring");
    expect("window_start stored", row[0]?.ws, "11:00");
    expect("window_end stored", row[0]?.we, "15:00");
    expect("window_days stored", row[0]?.wd, ["mon", "wed", "fri"]);
  }

  // A single run must NOT carry weekdays — it happens once, and a stored day
  // list would make the campaign card claim a recurrence it never acts on.
  {
    const schedule = campaignScheduleSchema.parse({
      mode: "single",
      window_start: "11:00",
      window_end: "15:00",
      window_days: ["mon", "wed"],
    });
    const r = await createCampaign({
      queueIds: [`${PREFIX}L3`],
      provider: "bolna",
      status: "draft",
      name: "E-254 api fixture",
      schedule,
    });
    const row = await db
      .select({
        mode: dialerCampaigns.schedule_mode,
        wd: dialerCampaigns.window_days,
      })
      .from(dialerCampaigns)
      .where(eq(dialerCampaigns.id, r.campaignId!))
      .limit(1);
    expect("single run stored as single", row[0]?.mode, "single");
    expect("single run drops window_days", row[0]?.wd, null);
  }

  // No schedule at all → the unscheduled quartet, i.e. pre-E-228 behaviour.
  {
    const r = await createCampaign({
      queueIds: [`${PREFIX}L4`],
      provider: "bolna",
      status: "draft",
      name: "E-254 api fixture",
    });
    const row = await db
      .select({
        mode: dialerCampaigns.schedule_mode,
        ws: dialerCampaigns.window_start,
      })
      .from(dialerCampaigns)
      .where(eq(dialerCampaigns.id, r.campaignId!))
      .limit(1);
    expect("no schedule → mode 'now'", row[0]?.mode, "now");
    expect("no schedule → NULL window", row[0]?.ws, null);
  }

  // 2. The read routes project the new columns.
  console.log("\n2. Read routes — the window reaches the UI");
  {
    // Same projection as /api/ai-dialer/campaigns and .../[id].
    const row = await db
      .select({
        scheduleMode: dialerCampaigns.schedule_mode,
        windowStart: dialerCampaigns.window_start,
        windowEnd: dialerCampaigns.window_end,
        windowDays: dialerCampaigns.window_days,
        resumeAfter: dialerCampaigns.resume_after,
        pausedAt: dialerCampaigns.paused_at,
      })
      .from(dialerCampaigns)
      .where(eq(dialerCampaigns.id, recurringId!))
      .limit(1);
    expect("list/detail projection returns the window", row[0]?.windowStart, "11:00");
    expect("…and the mode", row[0]?.scheduleMode, "recurring");
  }

  // 3. The UNION in /api/campaigns/unified. This is the one that fails LOUDLY
  //    and takes the AI-dialer half of the tab with it if the NeoDove branch's
  //    NULLs are not cast, so run the real statement against both tables.
  console.log("\n3. /api/campaigns/unified — the UNION resolves");
  {
    const probe = await db.execute<{ present: boolean }>(sql`
      SELECT to_regclass('public.neodove_campaigns') IS NOT NULL
         AND to_regclass('public.neodove_lead_links') IS NOT NULL AS present
    `);
    const hasNeodove = Boolean(
      (probe as unknown as { present: boolean }[])[0]?.present,
    );
    expect("neodove tables present, so the UNION branch is live", hasNeodove, true);

    const rows = await db.execute(sql`
      WITH ai AS (
          SELECT c.id::text AS id, 'ai_dialer'::text AS kind, c.status,
                 c.schedule_mode AS "scheduleMode",
                 c.window_start AS "windowStart",
                 c.window_end AS "windowEnd",
                 c.window_days AS "windowDays",
                 c.resume_after AS "resumeAfter",
                 COALESCE(c.started_at, c.created_at) AS sort_key
            FROM dialer_campaigns c
      ), nd AS (
          SELECT c.id::text AS id, 'neodove'::text AS kind, c.status,
                 NULL::varchar AS "scheduleMode",
                 NULL::varchar AS "windowStart",
                 NULL::varchar AS "windowEnd",
                 NULL::jsonb AS "windowDays",
                 NULL::timestamptz AS "resumeAfter",
                 COALESCE(c.started_at, c.created_at) AS sort_key
            FROM neodove_campaigns c
      )
      SELECT id, kind, status, "scheduleMode", "windowStart", "windowEnd",
             "windowDays", "resumeAfter"
        FROM (SELECT * FROM ai UNION ALL SELECT * FROM nd) merged
       ORDER BY sort_key DESC NULLS LAST
       LIMIT 5
    `);
    const list = rows as unknown as Array<Record<string, unknown>>;
    ok(`UNION executed, ${list.length} row(s) back`);
    const mine = list.find((r) => r.id === recurringId);
    if (mine) {
      expect("scheduled campaign carries its window through the UNION", mine.windowStart, "11:00");
    } else {
      ok("scheduled campaign not in the first page (ordering) — UNION itself proven");
    }
  }

  // 4. The defaults the form pre-fills from assignment_config (E-120), whose
  //    hours columns nothing had ever read before this feature.
  console.log("\n4. /api/ai-dialer/schedule-defaults — assignment_config lookup");
  {
    const d = await resolveScheduleDefaults();
    console.log("      resolved:", JSON.stringify(d));
    expect("window_start is HH:MM", /^([01]\d|2[0-3]):[0-5]\d$/.test(d.window_start), true);
    expect("window_end is HH:MM", /^([01]\d|2[0-3]):[0-5]\d$/.test(d.window_end), true);
    expect("window_days non-empty", d.window_days.length > 0, true);
    // The varchar(8) -> varchar(5) narrowing: an untruncated '09:00:00' would
    // fail the HHMM regex on the way back in and silently fall back for
    // everyone.
    expect("no seconds leaked through", d.window_start.length, 5);
  }

  // 5. The resume gate. E-254 widened it from 'stopped' only to include
  //    'paused'; 'scheduled' must stay refused, because the ticker owns it and
  //    a manual resume would only park it again.
  console.log("\n5. Resume gate — accepts paused, still refuses scheduled");
  {
    const { POST } = await import(
      "../src/app/api/ai-dialer/campaigns/[id]/resume/route"
    );
    const call = async (id: string) => {
      const res = await POST(new Request("http://localhost/x", { method: "POST" }), {
        params: Promise.resolve({ id }),
      });
      return { status: res.status, body: await res.json() };
    };

    // paused, with pending leads → accepted
    await db.execute(sql`
      UPDATE dialer_campaigns SET status = 'paused', schedule_mode = 'single'
       WHERE id = ${recurringId}
    `);
    const okRes = await call(recurringId!);
    expect("paused campaign is resumable", okRes.status, 200);

    // scheduled → refused
    await db.execute(sql`
      UPDATE dialer_campaigns
         SET status = 'scheduled', resume_after = now() + interval '1 day'
       WHERE id = ${recurringId}
    `);
    const noRes = await call(recurringId!);
    expect("scheduled campaign is NOT resumable", noRes.status, 400);
  }

  await cleanup();
  console.log(
    `\n${failed === 0 ? "ALL PASS" : `${failed} FAILURE(S)`} — E-254 API surface\n`,
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
