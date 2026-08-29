/**
 * Backfills E-236's disposition columns from history.
 *
 *   node --import tsx --env-file=.env.local scripts/backfill-dispositions.ts
 *   node --import tsx --env-file=.env.local scripts/backfill-dispositions.ts --dry-run
 *
 * WHY A BACKFILL IS POSSIBLE AT ALL. NeoDove has no read API, so a webhook they
 * drop is gone — which is exactly why `neodove_sync_events` exists and why it
 * stores the RAW inbound body in `request_payload`. Every disposition that ever
 * arrived is still on disk, unparsed. Without this script the new filter would
 * return nothing until the CC team touched each lead again, and a filter that
 * silently describes only the last few days is worse than no filter.
 *
 * NO SECOND PARSER. Both passes run the same `parseInboundEvent()` and
 * `dispositionFor()` the live webhook path uses. A backfill that classified
 * history slightly differently from live traffic would put two vocabularies in
 * one column and nobody would notice until the counts stopped adding up.
 *
 * TWO PASSES, because the two sources fail in different places:
 *   1. `neodove_sync_events.request_payload` — the complete record, used
 *      wherever it exists.
 *   2. `lead_touchpoints.remarks` — the prose line `remarksFor()` wrote
 *      ("[NeoDove] Disposition: … · Stage: … · Tag: …"). Only for touchpoints
 *      pass 1 could not reach: rows whose sync event was pruned, and rows
 *      written before the sync-event insert was in place. Lossy by nature, so
 *      it never overwrites what pass 1 established.
 *
 * IDEMPOTENT. Every UPDATE is guarded by `IS DISTINCT FROM`, so a second run
 * reports zero writes rather than churning the same rows — which is what makes
 * "run it again and confirm nothing changed" a meaningful check.
 *
 * The dealer_leads update carries the same forward-only guard as live inbound:
 * history is walked oldest-first, so the newest disposition wins naturally, and
 * a run of this script can never roll a lead backwards past a live webhook that
 * landed while it was running.
 */
import postgres from "postgres";

import { parseInboundEvent, dispositionFor } from "@/lib/neodove/mapper";

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH = 500;

type Counters = {
  eventsScanned: number;
  touchpointsUpdated: number;
  leadsUpdated: number;
  known: number;
  unmapped: number;
  noDisposition: number;
};

const unmappedLabels = new Map<string, number>();

function noteUnmapped(label: string) {
  unmappedLabels.set(label, (unmappedLabels.get(label) ?? 0) + 1);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (run with --env-file=.env.local)");
    process.exit(2);
  }

  const host = new URL(url).host;
  console.log(`host: ${host}`);
  console.log(DRY_RUN ? "mode: --dry-run (no writes)\n" : "mode: write\n");

  const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

  try {
    // Fail loudly rather than writing nothing and reporting success — "0 rows
    // updated" is also what a correctly-applied migration with no history looks
    // like, and the two must not be confusable.
    await assertMigrated(sql);

    const counts: Counters = {
      eventsScanned: 0,
      touchpointsUpdated: 0,
      leadsUpdated: 0,
      known: 0,
      unmapped: 0,
      noDisposition: 0,
    };

    await passFromSyncEvents(sql, counts);
    const remarkCounts = await passFromRemarks(sql);

    console.log("\n── summary ──────────────────────────────────────────");
    console.log(`  sync events scanned      ${counts.eventsScanned}`);
    console.log(`    → matched the sheet    ${counts.known}`);
    console.log(`    → outside the sheet    ${counts.unmapped}`);
    console.log(`    → named no disposition ${counts.noDisposition}`);
    console.log(`  touchpoints updated      ${counts.touchpointsUpdated}`);
    console.log(`  leads updated            ${counts.leadsUpdated}`);
    console.log(
      `  touchpoints from remarks ${remarkCounts.updated} (of ${remarkCounts.scanned} scanned)` +
        (DRY_RUN ? " — would update" : ""),
    );

    if (unmappedLabels.size) {
      // The point of printing these: a value here is either a typo worth an
      // alias in dispositions.ts, or evidence that a campaign is configured with
      // a different disposition list. Both need a human, and neither is visible
      // from the filter dropdown alone.
      console.log("\n  dispositions NOT in the CC sheet (label × count):");
      for (const [label, n] of [...unmappedLabels.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${String(n).padStart(5)}  ${label}`);
      }
      console.log(
        "\n  → add an alias in src/lib/leads/dispositions.ts if one of these is a\n" +
          "    spelling variant of a sheet value; otherwise they are a second\n" +
          "    campaign's vocabulary and are filterable as-is.",
      );
    }

    console.log(
      DRY_RUN
        ? "\ndry run complete — nothing was written"
        : "\nbackfill complete",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function assertMigrated(sql: postgres.Sql) {
  const rows = await sql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND ((table_name = 'dealer_leads' AND column_name = 'last_disposition')
         OR (table_name = 'lead_touchpoints' AND column_name = 'disposition'))
  `;
  const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const missing = ["dealer_leads.last_disposition", "lead_touchpoints.disposition"].filter(
    (c) => !have.has(c),
  );
  if (missing.length) {
    throw new Error(
      `E-236 is not applied on this database (missing ${missing.join(", ")}). ` +
        `Run: node --env-file=.env.local scripts/apply-e236.mjs`,
    );
  }
}

/** Pass 1 — the complete record. */
async function passFromSyncEvents(sql: postgres.Sql, counts: Counters) {
  console.log("pass 1: neodove_sync_events.request_payload");

  // external_event_id → dealer_lead_id, fetched ONCE.
  //
  // This used to be a per-event SELECT inside the loop. Correct, and roughly
  // 2,000 sequential round trips to RDS — the first dry run had not finished
  // after ten minutes. The whole map is a few thousand short rows; the network
  // was the entire cost, not the query.
  const linkRows = await sql<
    { external_event_id: string; dealer_lead_id: string }[]
  >`
    SELECT external_event_id, dealer_lead_id
      FROM lead_touchpoints
     WHERE external_system = 'neodove' AND external_event_id IS NOT NULL
  `;
  const leadByEvent = new Map(
    linkRows.map((r) => [r.external_event_id, r.dealer_lead_id]),
  );
  console.log(`  ${leadByEvent.size} existing neodove touchpoints indexed`);

  let after: { created_at: string; id: string } | null = null;
  for (;;) {
    // Keyset-paged on the WHOLE sort key `(created_at, id)` as a row value, not
    // OFFSET and not `id` alone. OFFSET would skip rows because the table grows
    // while this runs, and paging on `id` alone does not match the ordering, so
    // it would silently drop events whose uuid happens to sort low.
    const events = await sql<
      {
        id_text: string;
        created_at: Date;
        created_at_key: string;
        dealer_lead_id: string | null;
        external_event_id: string | null;
        request_payload: unknown;
      }[]
    >`
      -- ALIASED id_text, NOT "id::text". A bare \`id\` in ORDER BY binds to the
      -- OUTPUT column when one exists, so \`SELECT id::text\` + \`ORDER BY id\`
      -- would sort by the uuid's TEXT form while the keyset below compares real
      -- uuids — two orderings that disagree, and a page that then advances one
      -- row per query instead of 500.
      --
      -- created_at_key is the cursor value, as a MICROSECOND string.
      -- \`created_at\` comes back as a JS Date, which has millisecond precision;
      -- timestamptz has microsecond. Feeding the truncated Date back as the
      -- cursor makes the final row compare as greater than itself, so the query
      -- returns that one row forever and the loop never terminates. It did
      -- exactly that, ten thousand times over, before this line existed.
      SELECT id::text AS id_text,
             created_at,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               AS created_at_key,
             dealer_lead_id, external_event_id, request_payload
        FROM neodove_sync_events
       WHERE direction = 'inbound'
         AND request_payload IS NOT NULL
         ${
           after
             ? sql`AND (created_at, id) > (${after.created_at}::timestamptz, ${after.id}::uuid)`
             : sql``
         }
       ORDER BY created_at ASC, id ASC
       LIMIT ${BATCH}
    `;
    if (!events.length) break;

    for (const row of events) {
      counts.eventsScanned++;
      const event = parseInboundEvent(row.request_payload);
      const disposition = dispositionFor(event);
      if (!disposition) {
        counts.noDisposition++;
        continue;
      }
      if (disposition.isKnown) counts.known++;
      else {
        counts.unmapped++;
        noteUnmapped(disposition.label);
      }

      // The touchpoint the live path would have written. Matched on the
      // idempotency key, which is what ties a sync event to its touchpoint.
      const eventId = event.externalEventId ?? row.external_event_id;
      if (!eventId) continue;

      const occurredAt = event.occurredAt ?? row.created_at;

      if (!DRY_RUN) {
        const touched = await sql`
          UPDATE lead_touchpoints
             SET disposition        = ${disposition.label},
                 disposition_bucket = ${disposition.bucket},
                 connect_status     = ${disposition.connectStatus},
                 external_stage     = COALESCE(${event.stage}, external_stage),
                 external_tag       = COALESCE(${event.tag}, external_tag)
           WHERE external_system = 'neodove'
             AND external_event_id = ${eventId}
             AND (disposition IS DISTINCT FROM ${disposition.label}
               OR disposition_bucket IS DISTINCT FROM ${disposition.bucket}
               OR connect_status IS DISTINCT FROM ${disposition.connectStatus})
          RETURNING dealer_lead_id
        `;
        counts.touchpointsUpdated += touched.length;
      }

      // Resolve the lead: the sync event names it once handled; otherwise its
      // touchpoint does. Both can be absent for an event that never resolved to
      // a lead at all, which is a real outcome — see handleDisposition's
      // `unresolved` branch — and simply has nothing to backfill.
      const leadId = row.dealer_lead_id ?? leadByEvent.get(eventId) ?? null;
      if (!leadId) continue;

      if (!DRY_RUN) {
        const led = await sql`
          UPDATE dealer_leads
             SET last_disposition        = ${disposition.label},
                 last_disposition_bucket = ${disposition.bucket},
                 last_connect_status     = ${disposition.connectStatus},
                 last_disposition_at     = ${occurredAt},
                 last_disposition_source = 'neodove'
           WHERE id = ${leadId}
             AND (last_disposition_at IS NULL OR last_disposition_at <= ${occurredAt})
             AND (last_disposition IS DISTINCT FROM ${disposition.label}
               OR last_disposition_at IS DISTINCT FROM ${occurredAt})
          RETURNING id
        `;
        counts.leadsUpdated += led.length;
      }
    }

    const last = events[events.length - 1];
    const next = { created_at: last.created_at_key, id: last.id_text };
    // Belt and braces after the precision bug above: if a batch ends where the
    // previous one did, the cursor is not advancing and the only thing another
    // query can do is loop forever.
    if (after && after.created_at === next.created_at && after.id === next.id) {
      console.warn("  cursor stopped advancing — stopping pass 1");
      break;
    }
    after = next;
    console.log(`  scanned ${counts.eventsScanned}…`);
  }
  console.log(`  scanned ${counts.eventsScanned} events total`);
}

/**
 * Pass 2 — reconstruct from the prose line, for touchpoints pass 1 missed.
 *
 * `remarksFor()` writes "[NeoDove] Disposition: X · Stage: Y · Tag: Z · “words”".
 * The separator is " · " and no disposition in the sheet contains one, so the
 * split is unambiguous. Deliberately does NOT touch dealer_leads: a row that got
 * here has no reliable ordering signal beyond `performed_at`, and a lossy source
 * should not be allowed to decide a lead's CURRENT disposition.
 */
async function passFromRemarks(sql: postgres.Sql) {
  console.log("pass 2: lead_touchpoints.remarks (rows pass 1 could not reach)");

  const rows = await sql<
    { touchpoint_id: string; remarks: string | null }[]
  >`
    SELECT touchpoint_id::text, remarks
      FROM lead_touchpoints
     WHERE external_system = 'neodove'
       AND disposition IS NULL
       AND remarks LIKE '[NeoDove]%'
  `;

  let updated = 0;
  for (const row of rows) {
    const parsed = parseRemarks(row.remarks ?? "");
    // Feed the SAME classifier: tag first, exactly as dispositionFor() does.
    const disposition = dispositionFor({
      tag: parsed.tag,
      disposition: parsed.disposition,
      stage: parsed.stage,
      remarks: null,
      callConnected: null,
      // Fields parseInboundEvent would have set; irrelevant to classification.
      eventType: "lead_disposed",
      externalEventId: "",
      mobile: null,
      neodoveLeadId: null,
      itarangLeadId: null,
      campaignName: null,
      campaignId: null,
      dispositionCode: null,
      agentName: null,
      callDurationSec: null,
      recordingUrl: null,
      occurredAt: null,
      name: null,
      email: null,
      city: null,
      raw: null,
    });
    if (!disposition) continue;
    if (!disposition.isKnown) noteUnmapped(disposition.label);

    // Counted before the write so a --dry-run reports what it WOULD do. It
    // previously reported 0 either way, which is indistinguishable from "this
    // pass found nothing" — the one thing a dry run exists to tell you apart.
    if (DRY_RUN) {
      updated++;
    } else {
      const done = await sql`
        UPDATE lead_touchpoints
           SET disposition        = ${disposition.label},
               disposition_bucket = ${disposition.bucket},
               connect_status     = ${disposition.connectStatus},
               external_stage     = COALESCE(${parsed.stage}, external_stage),
               external_tag       = COALESCE(${parsed.tag}, external_tag)
         WHERE touchpoint_id = ${row.touchpoint_id}::uuid
           AND disposition IS NULL
        RETURNING touchpoint_id
      `;
      updated += done.length;
    }
  }

  console.log(
    `  scanned ${rows.length}, ${DRY_RUN ? "would update" : "updated"} ${updated}`,
  );
  return { scanned: rows.length, updated };
}

function parseRemarks(remarks: string): {
  disposition: string | null;
  stage: string | null;
  tag: string | null;
} {
  const body = remarks.replace(/^\[NeoDove\]\s*/, "");
  const out = { disposition: null as string | null, stage: null as string | null, tag: null as string | null };
  for (const segment of body.split(" · ")) {
    const m = /^(Disposition|Stage|Tag):\s*(.+)$/.exec(segment.trim());
    if (!m) continue;
    const value = m[2].trim();
    // "status code 6" is what remarksFor() writes when there was no readable
    // label — a numeric code, not a disposition, and it must not become one.
    if (/^status code /i.test(value)) continue;
    if (m[1] === "Disposition") out.disposition = value;
    if (m[1] === "Stage") out.stage = value;
    if (m[1] === "Tag") out.tag = value;
  }
  return out;
}

main().catch((error) => {
  console.error("\nFAILED:", error?.message ?? error);
  process.exit(1);
});
