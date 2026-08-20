// E-254 / E-228 — proves the calling-window SQL in src/lib/queue/campaignWindow.ts
// against the REAL database.
//
//   node --import tsx --env-file=.env.local scripts/verify-e254-campaign-window.ts
//
// Worth having because the window's behaviour lives in SQL, not TypeScript.
// tsc cannot tell you that `@>` matches an array ELEMENT rather than an array,
// that to_char(...,'dy') is padded, that an overnight window needs OR and not
// BETWEEN, or that `>=` instead of `>` on the next-opening query makes the
// resume ticker wake a campaign straight back into a shut window. Those are the
// bugs this catches. It is the E-241 precedent (scripts/verify-e241-queue-sql.mjs)
// applied to the dialer.
//
// Two properties make it trustworthy:
//
//   1. It IMPORTS windowOpenSql / nextWindowOpenSql from the application module
//      instead of restating them. A copy would pass forever while the real
//      predicate drifted underneath it.
//   2. Both predicates take an injectable `now`, so every case below is asserted
//      at a synthetic instant. Nothing here waits for a real 11am, and the run
//      is identical at any hour of any day.
//
// Entirely READ-ONLY: rows are supplied as an inline VALUES list, so there is no
// DDL, no temp table, and nothing to roll back. It cannot touch real campaigns.

import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import {
  windowOpenSql,
  nextWindowOpenSql,
} from "../src/lib/queue/campaignWindow";

let failed = 0;
const ok = (name: string) => console.log(`  PASS  ${name}`);
const bad = (name: string, detail: string) => {
  failed++;
  console.log(`  FAIL  ${name}\n        ${detail}`);
};

type Row = {
  schedule_mode: string;
  window_start: string | null;
  window_end: string | null;
  window_days: string[] | null;
};

// One campaign row as an inline VALUES list, with the same bare column names the
// predicates reference. Casts are explicit because VALUES has no table to infer
// types from, and an untyped NULL would make the predicate error rather than
// evaluate.
function rowFrom(r: Row) {
  return sql`(
    SELECT * FROM (VALUES (
      ${r.schedule_mode}::varchar,
      ${r.window_start}::varchar,
      ${r.window_end}::varchar,
      ${r.window_days === null ? null : JSON.stringify(r.window_days)}::jsonb
    )) AS t(schedule_mode, window_start, window_end, window_days)
  )`;
}

// IST instants are written as an explicit offset so the assertion means the same
// thing regardless of the server's timezone setting.
const at = (istLiteral: string) => sql`${istLiteral}::timestamptz`;

async function isOpen(r: Row, istNow: string): Promise<boolean> {
  const res = await db.execute<{ open: boolean }>(sql`
    SELECT ${windowOpenSql(at(istNow))} AS open FROM ${rowFrom(r)} AS c
  `);
  return Boolean((res as unknown as { open: boolean }[])[0]?.open);
}

async function nextOpen(r: Row, istNow: string): Promise<string | null> {
  const res = await db.execute<{ next_open: string | null }>(sql`
    SELECT to_char(
             ${nextWindowOpenSql(at(istNow))} AT TIME ZONE 'Asia/Kolkata',
             'YYYY-MM-DD HH24:MI'
           ) AS next_open
      FROM ${rowFrom(r)} AS c
  `);
  return (
    (res as unknown as { next_open: string | null }[])[0]?.next_open ?? null
  );
}

async function expectOpen(name: string, r: Row, istNow: string, want: boolean) {
  try {
    const got = await isOpen(r, istNow);
    if (got === want) ok(name);
    else bad(name, `expected open=${want}, got open=${got} at ${istNow}`);
  } catch (e) {
    bad(name, e instanceof Error ? e.message : String(e));
  }
}

async function expectNext(
  name: string,
  r: Row,
  istNow: string,
  want: string | null,
) {
  try {
    const got = await nextOpen(r, istNow);
    if (got === want) ok(name);
    else bad(name, `expected next_open=${want}, got ${got} (now=${istNow})`);
  } catch (e) {
    bad(name, e instanceof Error ? e.message : String(e));
  }
}

// 2026-08-19 is a Wednesday; 2026-08-24 is the following Monday. Fixed dates
// keep the weekday assertions meaningful.
const WED = "2026-08-19";
const THU = "2026-08-20";
const MON_NEXT = "2026-08-24";
const ist = (day: string, hm: string) => `${day} ${hm}:00+05:30`;

const DAY: Row = {
  schedule_mode: "recurring",
  window_start: "11:00",
  window_end: "15:00",
  window_days: ["mon", "tue", "wed", "thu", "fri"],
};
const OVERNIGHT: Row = { ...DAY, window_start: "22:00", window_end: "06:00" };
const MON_ONLY: Row = { ...DAY, window_days: ["mon"] };
const EVERY_DAY: Row = { ...DAY, window_days: null };
const SINGLE: Row = { ...DAY, schedule_mode: "single", window_days: null };
const UNSCHEDULED: Row = {
  schedule_mode: "now",
  window_start: null,
  window_end: null,
  window_days: null,
};
// A 'now' row that still carries stale window values — proves the mode
// short-circuit fires before anything reads the bounds.
const NOW_WITH_STALE: Row = { ...DAY, schedule_mode: "now" };

async function main() {
  console.log("\nwindowOpenSql — plain daytime window 11:00-15:00 Mon-Fri");
  await expectOpen("open mid-window (13:00 Wed)", DAY, ist(WED, "13:00"), true);
  await expectOpen(
    "open exactly at start (11:00)",
    DAY,
    ist(WED, "11:00"),
    true,
  );
  await expectOpen(
    "SHUT exactly at end (15:00)",
    DAY,
    ist(WED, "15:00"),
    false,
  );
  await expectOpen("shut before start (10:59)", DAY, ist(WED, "10:59"), false);
  await expectOpen("shut after end (15:01)", DAY, ist(WED, "15:01"), false);
  await expectOpen("shut at night (23:00)", DAY, ist(WED, "23:00"), false);

  console.log("\nwindowOpenSql — weekday filter");
  await expectOpen(
    "shut mid-window on an unlisted day (Sat 13:00)",
    DAY,
    ist("2026-08-22", "13:00"),
    false,
  );
  await expectOpen(
    "Monday-only campaign shut on Wednesday mid-window",
    MON_ONLY,
    ist(WED, "13:00"),
    false,
  );
  await expectOpen(
    "Monday-only campaign open on Monday mid-window",
    MON_ONLY,
    ist(MON_NEXT, "13:00"),
    true,
  );
  await expectOpen(
    "null window_days means every day (Sunday 13:00)",
    EVERY_DAY,
    ist("2026-08-23", "13:00"),
    true,
  );

  console.log("\nwindowOpenSql — overnight window 22:00-06:00 (the wrap)");
  await expectOpen(
    "open before midnight (23:00)",
    OVERNIGHT,
    ist(WED, "23:00"),
    true,
  );
  await expectOpen(
    "open after midnight (02:00)",
    OVERNIGHT,
    ist(THU, "02:00"),
    true,
  );
  await expectOpen(
    "shut at midday (12:00)",
    OVERNIGHT,
    ist(WED, "12:00"),
    false,
  );
  await expectOpen(
    "shut exactly at end (06:00)",
    OVERNIGHT,
    ist(THU, "06:00"),
    false,
  );

  console.log("\nwindowOpenSql — backward compatibility (E-228's guarantee)");
  await expectOpen(
    "unscheduled row open at 03:00",
    UNSCHEDULED,
    ist(WED, "03:00"),
    true,
  );
  await expectOpen(
    "mode='now' short-circuits stale window values at 03:00",
    NOW_WITH_STALE,
    ist(WED, "03:00"),
    true,
  );

  console.log("\nwindowOpenSql — single run uses the same gate as recurring");
  await expectOpen("single open mid-window", SINGLE, ist(WED, "13:00"), true);
  await expectOpen("single shut after end", SINGLE, ist(WED, "15:30"), false);

  console.log("\nnextWindowOpenSql — when does it next open?");
  await expectNext(
    "before today's start → today's start",
    DAY,
    ist(WED, "09:00"),
    `${WED} 11:00`,
  );
  await expectNext(
    "after today's end → tomorrow's start (NOT today's, already past)",
    DAY,
    ist(WED, "15:00"),
    `${THU} 11:00`,
  );
  await expectNext(
    "mid-window → today's start is past, so tomorrow",
    DAY,
    ist(WED, "13:00"),
    `${THU} 11:00`,
  );
  await expectNext(
    "Friday evening skips the unlisted weekend → Monday",
    DAY,
    ist("2026-08-21", "16:00"),
    `${MON_NEXT} 11:00`,
  );
  await expectNext(
    "Monday-only, closing Monday → next Monday (7 days out)",
    MON_ONLY,
    ist(MON_NEXT, "15:00"),
    "2026-08-31 11:00",
  );
  await expectNext(
    "unscheduled row has no next opening",
    UNSCHEDULED,
    ist(WED, "15:00"),
    null,
  );
  await expectNext(
    "mode='now' has no next opening even with window values set",
    NOW_WITH_STALE,
    ist(WED, "15:00"),
    null,
  );

  // The tight-loop regression. If nextWindowOpenSql used >= instead of >, a
  // campaign closing at exactly its own start time would resolve that same
  // instant, and the ticker would wake it into a window it is about to leave.
  await expectNext(
    "closing AT the start instant resolves the NEXT day, not now",
    DAY,
    ist(WED, "11:00"),
    `${THU} 11:00`,
  );

  console.log(
    `\n${failed === 0 ? "ALL PASS" : `${failed} FAILURE(S)`} — ` +
      "windowOpenSql + nextWindowOpenSql\n",
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify script threw:", e);
  process.exit(1);
});
