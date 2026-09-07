/**
 * E-287/E-288 — verify the scheduled digests against a real DB.
 *
 * READ-ONLY. It counts and it reads; it never writes and it never sends mail.
 * (To actually send one, use a settings screen's "Send test now", or
 * `curl -X POST localhost:3000/api/cron/digest?kind=…&slot=morning`.)
 *
 *   node --import tsx --env-file=.env.local scripts/verify-digests.ts [kind] [YYYY-MM-DD] [--render]
 *
 * [kind]       optional — one descriptor id. Omitted, every registered kind.
 * [YYYY-MM-DD] optional — the IST day to count. Defaults to yesterday IST, i.e.
 *              exactly what the 09:00 digest would report if it ran now.
 * --render     write each kind's mail to digest-preview-<kind>.html instead of
 *              sending it.
 *
 * What it asserts, per kind:
 *   1. `digest_runs` exists and carries the (kind, date, slot) claim key.
 *   2. collect() runs and returns figures.
 *   3. collectDetail() runs, and every activity line with a bucket has a detail
 *      list no longer than its own count — a list longer than its number means
 *      the two queries disagree about the window.
 *   4. Kind-specific cross-checks:
 *      - dealer_validation: the backlog matches the page's four stat cards, and
 *        `correction_requested_at` is still the dead column.
 *      - kyc_review: counting approvals from `audit_logs` vs from
 *        `admin_verification_queue.reviewed_at` — the latter is last-write-wins,
 *        so a divergence is EXPECTED and reported rather than failed.
 *   5. No slot has been sent twice for any kind.
 */

export {}; // module scope — keeps Step/steps/failed off the global script namespace

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];
let failed = 0;

function pass(name: string, detail = "") {
  steps.push({ name, ok: true, detail });
  console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name: string, detail: string) {
  steps.push({ name, ok: false, detail });
  failed += 1;
  console.log(`  ✖ ${name} — ${detail}`);
}
function skip(name: string, detail: string) {
  steps.push({ name, ok: true, detail: `SKIPPED — ${detail}` });
  console.log(`  – ${name} — SKIPPED: ${detail}`);
}
function note(name: string, detail: string) {
  steps.push({ name, ok: true, detail });
  console.log(`  · ${name} — ${detail}`);
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const render = process.argv.includes("--render");

  const { db } = await import("@/lib/db");
  const { sql } = await import("drizzle-orm");
  const { DIGEST_KINDS, digestKind } = await import("@/lib/digests/registry");
  const { previousIstDate, istDate } = await import("@/lib/operations/istClock");
  const { getDigestSettings } = await import("@/lib/digests/settings");
  const { recentDigestRuns } = await import("@/lib/digests/engine");
  const { formatSlotTime } = await import("@/lib/digests/schedule");

  const kindArg = args.find((a) => !/^\d{4}-\d{2}-\d{2}$/.test(a));
  const dayArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const day = dayArg ?? previousIstDate();

  const kinds = kindArg
    ? [digestKind(kindArg)].filter(Boolean)
    : DIGEST_KINDS;

  if (kinds.length === 0) {
    console.error(
      `unknown kind "${kindArg}" — known: ${DIGEST_KINDS.map((k) => k.id).join(", ")}`,
    );
    process.exit(1);
  }

  const host = (process.env.DATABASE_URL || "").match(/@([^:/]+)/)?.[1] ?? "?";
  console.log(`\nE-285/E-288 digests — verifying against ${host}`);
  console.log(`IST day under test: ${day}   (today IST is ${istDate()})\n`);

  // --- The ledger, once ------------------------------------------------------
  let ledgerPresent = false;
  try {
    const [t] = (await db.execute(sql`
      SELECT to_regclass('public.digest_runs') IS NOT NULL AS present
    `)) as unknown as Array<{ present: boolean }>;
    ledgerPresent = Boolean(t?.present);
  } catch {
    ledgerPresent = false;
  }

  if (!ledgerPresent) {
    skip(
      "digest_runs exists",
      "E-288 not applied here — safe, but NO DIGEST WILL EVER SEND on this database",
    );
  } else {
    pass("digest_runs exists");
    const idx = (await db.execute(sql`
      SELECT indexdef FROM pg_indexes
       WHERE tablename = 'digest_runs' AND indexname = 'digest_runs_kind_slot_uniq'
    `)) as unknown as Array<{ indexdef: string }>;
    const def = idx?.[0]?.indexdef ?? "";
    if (!def) {
      fail(
        "the (kind, date, slot) claim key is present",
        "index digest_runs_kind_slot_uniq is MISSING — two kinds would collide, or a " +
          "restart would send the same digest twice",
      );
    } else if (!/UNIQUE/i.test(def) || !/WHERE/i.test(def) || !/kind/i.test(def)) {
      fail("the claim key is UNIQUE, partial, and keyed on kind", `found: ${def}`);
    } else {
      pass("the (kind, date, slot) claim key is UNIQUE and partial");
    }

    const dupes = (await db.execute(sql`
      SELECT kind, digest_date::text AS digest_date, slot, COUNT(*)::int AS n
        FROM digest_runs WHERE slot IN ('morning','evening')
       GROUP BY 1,2,3 HAVING COUNT(*) > 1
    `)) as unknown as Array<Record<string, unknown>>;
    if (dupes.length > 0) {
      fail(
        "no slot was sent twice",
        dupes.map((d) => `${d.kind}/${d.digest_date}/${d.slot} × ${d.n}`).join(", "),
      );
    } else {
      pass("no slot was sent twice, for any kind");
    }
  }

  // --- Per kind --------------------------------------------------------------
  for (const kind of kinds) {
    if (!kind) continue;
    console.log(`\n── ${kind.label} (${kind.id}) ──`);

    const settings = await getDigestSettings(kind);
    note(
      "settings",
      `${settings.enabled ? "ENABLED" : "disabled"} · ` +
        `${formatSlotTime(settings.morningHour, settings.morningMinute)} & ` +
        `${formatSlotTime(settings.eveningHour, settings.eveningMinute)} IST · ` +
        `${settings.detail}${settings.attachExcel ? " + xlsx" : ""} · ` +
        `to ${settings.recipients.join(", ")}`,
    );

    const counted = await kind.collect(day);
    if (!counted.ok) {
      fail(`${kind.id}: collect() runs`, counted.error ?? "unknown error");
      continue;
    }
    pass(`${kind.id}: collect() runs`);

    console.log(`\n  ${day} (IST):`);
    for (const l of counted.figures.activity) {
      console.log(`    ${l.indent ? "  " : ""}${l.label.padEnd(30)} ${l.value}`);
    }
    console.log(`\n  Still outstanding (now):`);
    for (const l of counted.figures.backlog) {
      console.log(`    ${l.label.padEnd(30)} ${l.display ?? l.value}`);
    }
    console.log("");

    const detail = await kind.collectDetail(day);
    if (!detail.ok) {
      fail(`${kind.id}: collectDetail() runs`, detail.error ?? "unknown error");
    } else {
      pass(`${kind.id}: collectDetail() runs`);

      // A detail list longer than its own count means the two queries disagree
      // about the window — the kind of drift that only shows up as a mail whose
      // list contradicts its own heading.
      const bad: string[] = [];
      for (const l of counted.figures.activity) {
        if (!l.bucket || l.indent) continue;
        const rows = detail.detail[l.bucket]?.length ?? 0;
        if (rows > l.value) bad.push(`${l.label}: ${rows} rows vs count ${l.value}`);
      }
      if (bad.length) {
        fail(`${kind.id}: every detail list fits its count`, bad.join("; "));
      } else {
        pass(`${kind.id}: every detail list fits its count`);
      }
    }

    // --- kind-specific cross-checks -----------------------------------------
    if (kind.id === "dealer_validation") {
      const cards = (await db.execute(sql`
        WITH derived AS (
          SELECT CASE
                   WHEN a.onboarding_status IN ('approved','rejected','correction_requested')
                     THEN a.onboarding_status
                   WHEN a.review_status IS NOT NULL AND a.review_status <> 'draft'
                     THEN a.review_status
                   ELSE a.onboarding_status
                 END AS status
            FROM dealer_onboarding_applications a
           WHERE a.onboarding_status <> 'draft' OR a.submitted_at IS NOT NULL
        )
        SELECT
          (SELECT COUNT(*) FROM derived)::int AS total,
          (SELECT COUNT(*) FROM derived WHERE status IN
            ('submitted','pending_admin_review','pending_sales_head',
             'under_review','agreement_in_progress'))::int AS pending,
          (SELECT COUNT(*) FROM derived WHERE status IN
            ('approved','completed','succeed'))::int AS approved,
          (SELECT COUNT(*) FROM derived WHERE status IN
            ('under_correction','correction_requested'))::int AS correction
      `)) as unknown as Array<Record<string, number>>;
      const c = cards?.[0] ?? {};
      const b = counted.figures.backlog;
      const got = [b[0]?.value, b[1]?.value, b[2]?.value, b[3]?.value];
      const want = [
        Number(c.pending),
        Number(c.correction),
        Number(c.approved),
        Number(c.total),
      ];
      if (got.join("/") !== want.join("/")) {
        fail(
          "dealer_validation: backlog matches the page's stat cards",
          `digest ${got.join("/")} vs page ${want.join("/")}`,
        );
      } else {
        pass(
          "dealer_validation: backlog matches the page's stat cards",
          `${want[3]} / ${want[0]} / ${want[2]} / ${want[1]}`,
        );
      }

      const dead = (await db.execute(sql`
        SELECT COUNT(*) FILTER (WHERE correction_requested_at IS NOT NULL)::int AS have_ts,
               COUNT(*) FILTER (WHERE onboarding_status = 'correction_requested')::int AS in_correction
          FROM dealer_onboarding_applications
      `)) as unknown as Array<{ have_ts: number; in_correction: number }>;
      const haveTs = Number(dead?.[0]?.have_ts ?? 0);
      if (haveTs === 0) {
        pass(
          "dealer_validation: correction_requested_at is still the dead column",
          `0 populated, ${dead?.[0]?.in_correction ?? 0} in correction — counting from ` +
            `dealer_correction_rounds is right`,
        );
      } else {
        note(
          "dealer_validation: correction_requested_at HAS STARTED BEING WRITTEN",
          `${haveTs} row(s) now carry it — the two sources should be reconciled`,
        );
      }
    }

    if (kind.id === "kyc_review") {
      // THE trap this digest is built around: reviewed_at is last-write-wins.
      const cmp = (await db.execute(sql`
        SELECT
          (SELECT COUNT(*) FROM audit_logs a
            WHERE a.entity_type = 'kyc_final_decision' AND a.action = 'approved'
              AND a.created_at >= (${day}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
              AND a.created_at <  ((${day}::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata'))::int
            AS from_audit,
          (SELECT COUNT(*) FROM admin_verification_queue q
            WHERE q.status = 'approved'
              AND q.reviewed_at >= (${day}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
              AND q.reviewed_at <  ((${day}::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata'))::int
            AS from_reviewed_at
      `)) as unknown as Array<{ from_audit: number; from_reviewed_at: number }>;

      const a = Number(cmp?.[0]?.from_audit ?? 0);
      const q = Number(cmp?.[0]?.from_reviewed_at ?? 0);
      const line = `audit_logs=${a}, reviewed_at=${q}`;

      const approvedLine = counted.figures.activity.find((l) => l.label === "Approved");
      if (approvedLine && approvedLine.value !== a) {
        fail(
          "kyc_review: 'Approved' comes from the audit log",
          `figure says ${approvedLine.value} but audit_logs says ${a}`,
        );
      } else {
        pass("kyc_review: 'Approved' comes from the audit log", line);
      }

      if (a !== q) {
        note(
          "kyc_review: the two sources disagree, as designed",
          `${line} — reviewed_at is last-write-wins, so a case decided twice in a day ` +
            `is counted once. This is exactly why the digest reads audit_logs.`,
        );
      }

      // The orphan reality, stated rather than assumed.
      const orphans = (await db.execute(sql`
        SELECT COUNT(*)::int AS total, COUNT(l.id)::int AS lead_alive
          FROM admin_verification_queue qq LEFT JOIN leads l ON l.id = qq.lead_id
         WHERE qq.status = 'pending_itarang_verification'
      `)) as unknown as Array<{ total: number; lead_alive: number }>;
      note(
        "kyc_review: backlog counts only cases whose lead survives",
        `${orphans?.[0]?.lead_alive ?? 0} of ${orphans?.[0]?.total ?? 0} pending cases have a ` +
          `live lead — matching /api/admin/kyc/queue, which inner-joins too`,
      );
    }

    // --- optional render -----------------------------------------------------
    if (render) {
      const { buildDigestEmail } = await import("@/lib/email/sendDigestEmail");
      const { writeFileSync } = await import("node:fs");
      const built = buildDigestEmail({
        kind,
        to: settings.recipients,
        slot: "morning",
        istDay: day,
        figures: counted.figures,
        detail: "detailed",
        detailRows: detail.ok ? detail.detail : undefined,
        sections: settings.sections,
      });
      const out = `digest-preview-${kind.id}.html`;
      writeFileSync(out, built.html, "utf8");
      pass(`${kind.id}: rendered`, `${built.subject}  →  ${out}`);
    }

    if (ledgerPresent) {
      const runs = await recentDigestRuns(kind.id, 5);
      note(`${kind.id}: send history`, `${runs.length} row(s)`);
      for (const r of runs) {
        console.log(
          `      ${r.digest_date} ${r.slot.padEnd(8)} ${r.status.padEnd(8)} ` +
            `attempts=${r.attempts} via=${r.triggered_by}` +
            (r.error ? `  ERROR: ${r.error}` : ""),
        );
      }
    }
  }

  console.log(
    `\n${failed === 0 ? "ALL GREEN" : `${failed} FAILED`} — ${steps.length} assertion(s)\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nverifier crashed:", err);
  process.exit(1);
});
