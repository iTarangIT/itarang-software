/**
 * Enqueues ONE `buyback_notification_events` row so the in-process
 * dispatcher (src/lib/buyback/dispatch.ts, ticked every 30s by
 * startBuybackDispatchTicker() in src/instrumentation-node.ts while
 * `npm run dev` — or a deployed server — is running) picks it up and
 * attempts a REAL send through whichever mailer is configured (AgentMail or
 * SMTP fallback — see docs/peakAmp/EMAIL_SETUP.md for exactly what that
 * means per environment).
 *
 * This script does NOT send anything itself. It only INSERTs a PENDING row
 * with channel=EMAIL and party=ADMIN, addressed to the `--to` you supply.
 * The dispatcher, running separately, does the actual send within ~30s.
 *
 * `request_id` on buyback_notification_events is NOT NULL with a real FK to
 * buyback_requests — this script piggybacks on whatever request already
 * exists (most-recently-created) rather than fabricating one; it refuses to
 * run if none exists.
 *
 * Run: npx tsx --env-file=.env.local scripts/buyback-email-smoke.ts --to you@example.com
 * Optional: --timestamp <string>  (defaults to Date.now()) — lets you pin the
 *           idempotency_key when re-running deliberately.
 */

import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";

interface Args {
  to: string;
  timestamp: string;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, "true");
    }
  }

  const to = flags.get("to");
  if (!to) {
    console.error("Usage: npx tsx --env-file=.env.local scripts/buyback-email-smoke.ts --to you@example.com");
    console.error("The --to argument is required — this script refuses to enqueue an event with no recipient.");
    process.exit(1);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    console.error(`"${to}" does not look like an email address.`);
    process.exit(1);
  }

  // This is a script, not app code — the timestamp comes from an explicit
  // argument or new Date() here, never an implicit DB-side default.
  const timestamp = flags.get("timestamp") ?? Date.now().toString();

  return { to, timestamp };
}

async function main() {
  const { to, timestamp } = parseArgs(process.argv.slice(2));

  const [request] = (await db.execute(sql`
    SELECT id, request_no FROM buyback_requests ORDER BY created_at DESC LIMIT 1
  `)) as unknown as Array<{ id: string; request_no: string }>;

  if (!request) {
    console.error(
      "No buyback_requests row exists in this database to attach the smoke event to " +
        "(request_id is NOT NULL with a real foreign key — it cannot be fabricated). " +
        "Create at least one buyback request first, then re-run.",
    );
    process.exit(1);
  }

  const idempotencyKey = `smoke-${timestamp}`;
  const nextAttemptAt = new Date().toISOString();

  const [row] = (await db.execute(sql`
    INSERT INTO buyback_notification_events
      (request_id, event_type, recipient_party, channel, payload,
       idempotency_key, delivery_status, recipient_ref, next_attempt_at)
    VALUES
      (${request.id}::uuid,
       'smoke_test',
       'ADMIN',
       'EMAIL',
       ${JSON.stringify({ request_no: request.request_no, kind: "smoke_test" })}::jsonb,
       ${idempotencyKey},
       'PENDING',
       ${to},
       ${nextAttemptAt}::timestamptz)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;

  if (!row) {
    console.error("Insert did not return a row — nothing was enqueued.");
    process.exit(1);
  }

  console.log(`Enqueued buyback_notification_events row: ${row.id}`);
  console.log(`  idempotency_key: ${idempotencyKey}`);
  console.log(`  recipient_ref:   ${to}`);
  console.log(`  attached to:     ${request.request_no} (${request.id})`);
  console.log("");
  console.log("This did NOT send anything. With the app running (npm run dev, or a");
  console.log("deployed sandbox/prod server), the in-process dispatcher ticks every 30s");
  console.log("and will attempt delivery through whichever mailer is configured — see");
  console.log("docs/peakAmp/EMAIL_SETUP.md.");
  console.log("");
  console.log("Check delivery_status once the tick has had a chance to run:");
  console.log("");
  console.log(
    `  SELECT delivery_status, sent_at, attempts, error FROM buyback_notification_events WHERE id = '${row.id}';`,
  );
  console.log("");
  console.log("PENDING -> SENT means the mailer accepted it. Still PENDING after a");
  console.log("minute or two, or FAILED, means check `error` — most commonly a missing");
  console.log("AGENTMAIL_API_KEY/AGENTMAIL_INBOX or SMTP_* env var in this environment.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
