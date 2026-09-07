/**
 * One digest send — one unit of work, three callers (E-287, generalised E-288).
 *
 * The in-process ticker (src/instrumentation-node.ts), the cron route
 * (/api/cron/digest) and the settings screen's "Send test now" button all come
 * through here, so there is exactly one place that decides what a send IS.
 * Swapping the ticker for a real queue consumer later changes the caller, not
 * this file.
 *
 * THE CLAIM IS THE WHOLE POINT
 *   All three callers can be live at once — the ticker on every PM2 process that
 *   boots instrumentation, plus a crontab curl. Rather than coordinate them, each
 *   races to INSERT the (kind, digest_date, slot) row and only the winner gets an
 *   id back; everyone else is told the slot is taken and returns quietly. The lock
 *   is the partial unique index from E-288, the same trick
 *   ops_collector_runs_one_active_idx plays for the Ops collectors.
 *
 *   `kind` is part of the key, which is what lets two digests both send at 09:00.
 *
 * WHAT IS AND IS NOT RETRIED
 *   A `sent` row is terminal: that slot is done for the day, full stop. A `failed`
 *   row is re-claimable while attempts < 3, so a transient provider error
 *   self-heals on the next five-minute tick; after three it stops, because a
 *   misconfigured mailbox retrying every five minutes until midnight helps nobody.
 *   A row stuck in `sending` — the process died mid-send — is re-claimable after
 *   15 minutes.
 *
 * A DIGEST IT COULD NOT COUNT IS NOT SENT
 *   If the figures query fails, the run is marked `failed` and no mail goes out.
 *   An email of confident zeros is worse than no email: it reads exactly like a
 *   quiet day, and the whole reason these exist is that nobody was watching.
 *   A DETAIL or attachment failure only DOWNGRADES the mail to a summary — the
 *   figures are the point, and a summary that arrives beats a detailed one that
 *   does not.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { sendDigestEmail } from "@/lib/email/sendDigestEmail";

import { getDigestSettings } from "./settings";
import { digestDateForSlot, slotsDueAt } from "./schedule";
import type { DigestSettings, DigestSlot } from "./schedule";
import type { DigestFigures, DigestKindDescriptor } from "./types";

/** How long a claim may sit in `sending` before another process may take it. */
const STUCK_CLAIM_MINUTES = 15;

/** How many times a failed slot is retried before it is left alone for the day. */
const MAX_ATTEMPTS = 3;

export type DigestRunSlot = DigestSlot | "test";
export type DigestTrigger = "ticker" | "cron" | "manual";

export type DigestRunOutcome = {
  kind: string;
  slot: DigestRunSlot;
  digestDate: string;
  sent: boolean;
  /** Why nothing was sent. Absent when `sent` is true. */
  skipped?: string;
  figures?: DigestFigures;
  recipients?: string[];
  error?: string;
};

export type DigestRunResult = {
  ok: boolean;
  outcomes: DigestRunOutcome[];
};

/** Flatten figures into the jsonb the ledger keeps beside a send. */
function figuresToCounts(f: DigestFigures): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of [...f.activity, ...f.backlog]) {
    // Labels are unique within a digest; the key is for humans reading the row.
    out[l.label] = l.value;
  }
  return out;
}

/**
 * Take the slot, or find out somebody else already has it.
 *
 * Returns the ledger row id on success and null when the slot is unavailable —
 * already sent, in flight elsewhere, or out of retries. A DB error is also null:
 * an environment without E-288 applied simply never sends, which is the
 * documented safe-to-skip behaviour.
 */
async function claimSlot(
  kind: string,
  slot: DigestSlot,
  digestDate: string,
  triggeredBy: DigestTrigger,
  recipients: string[],
): Promise<number | null> {
  try {
    const rows = (await db.execute(sql`
      INSERT INTO digest_runs
        (kind, digest_date, slot, status, attempts, triggered_by, recipients, claimed_at)
      VALUES
        (${kind}, ${digestDate}::date, ${slot}, 'sending', 1, ${triggeredBy},
         ${recipients.join(", ")}, now())
      ON CONFLICT (kind, digest_date, slot) WHERE slot IN ('morning', 'evening')
      DO UPDATE SET
        status       = 'sending',
        attempts     = digest_runs.attempts + 1,
        claimed_at   = now(),
        triggered_by = EXCLUDED.triggered_by,
        recipients   = EXCLUDED.recipients
      WHERE
        (digest_runs.status = 'failed' AND digest_runs.attempts < ${MAX_ATTEMPTS})
        OR (digest_runs.status = 'sending'
            AND digest_runs.claimed_at < now() - make_interval(mins => ${STUCK_CLAIM_MINUTES}))
      RETURNING id
    `)) as unknown as Array<{ id: number }>;

    return rows?.[0]?.id ?? null;
  } catch (err) {
    console.error(`[digest:${kind}] claim failed:`, err);
    return null;
  }
}

/** Close out a claimed row. Never throws — the mail already went (or did not). */
async function finishRun(
  id: number,
  status: "sent" | "failed",
  figures: DigestFigures | null,
  messageId: string | null,
  error: string | null,
): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE digest_runs
         SET status     = ${status},
             counts     = ${JSON.stringify(figures ? figuresToCounts(figures) : {})}::jsonb,
             message_id = ${messageId},
             error      = ${error}
       WHERE id = ${id}
    `);
  } catch (err) {
    console.error("[digest] failed to close run row:", err);
  }
}

/** Record a test send. Best-effort — a test that mailed but did not log is fine. */
async function recordTestRun(
  kind: string,
  digestDate: string,
  triggeredBy: DigestTrigger,
  recipients: string[],
  status: "sent" | "failed",
  figures: DigestFigures | null,
  messageId: string | null,
  error: string | null,
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO digest_runs
        (kind, digest_date, slot, status, attempts, triggered_by, recipients,
         counts, message_id, error)
      VALUES
        (${kind}, ${digestDate}::date, 'test', ${status}, 1, ${triggeredBy},
         ${recipients.join(", ")},
         ${JSON.stringify(figures ? figuresToCounts(figures) : {})}::jsonb,
         ${messageId}, ${error})
    `);
  } catch (err) {
    console.error("[digest] failed to record test run:", err);
  }
}

/** Count, then mail. Shared by the real slots and the test send. */
async function countAndSend(
  kind: DigestKindDescriptor,
  slot: DigestRunSlot,
  digestDate: string,
  recipients: string[],
  settings: DigestSettings,
): Promise<{
  ok: boolean;
  figures: DigestFigures | null;
  messageId: string | null;
  error?: string;
}> {
  const counted = await kind.collect(digestDate);
  if (!counted.ok) {
    return {
      ok: false,
      figures: null,
      messageId: null,
      error: `count failed: ${counted.error ?? "unknown"}`,
    };
  }

  // The rows are needed by the detailed format AND by the attachment, so fetch
  // them once when either wants them — never twice, and never at all for the
  // common summary-with-no-attachment case.
  const needsRows = settings.detail === "detailed" || settings.attachExcel;
  const detail = needsRows ? await kind.collectDetail(digestDate) : null;

  if (detail && !detail.ok) {
    console.error(
      `[digest:${kind.id}] detail unavailable for ${digestDate}, sending summary instead: ${detail.error}`,
    );
  }
  const rows = detail?.ok ? detail.detail : null;

  let attachment: { filename: string; content: Buffer; contentType: string } | null = null;

  if (settings.attachExcel && rows) {
    try {
      const { buildDigestXlsx, digestWorkbookFilename, XLSX_CONTENT_TYPE } = await import(
        "@/lib/excel/digestWorkbook"
      );
      attachment = {
        filename: digestWorkbookFilename(kind.id, digestDate),
        content: await buildDigestXlsx({
          kind,
          istDay: digestDate,
          figures: counted.figures,
          detail: rows,
          sections: settings.sections,
        }),
        contentType: XLSX_CONTENT_TYPE,
      };
    } catch (err) {
      console.error(
        `[digest:${kind.id}] could not build the xlsx, sending without it:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const sent = await sendDigestEmail({
    kind,
    to: recipients,
    slot,
    istDay: digestDate,
    figures: counted.figures,
    detail: settings.detail,
    detailRows: rows ?? undefined,
    sections: settings.sections,
    attachment,
  });

  return {
    ok: sent.ok,
    figures: counted.figures,
    messageId: sent.messageId,
    error: sent.error,
  };
}

/**
 * Send every slot this kind currently owes, or one named slot.
 *
 * - no `slot`      → whatever `slotsDueAt()` says is due (the ticker's call)
 * - `"morning" | "evening"` → force that slot, still subject to the claim
 * - `"test"`       → skip the claim entirely and mail immediately
 */
export async function runDigest(opts: {
  kind: DigestKindDescriptor;
  slot?: DigestRunSlot;
  triggeredBy: DigestTrigger;
  now?: Date;
  /** Test sends only — mail these addresses instead of the configured ones. */
  toOverride?: string[];
  /** Test sends only — count this IST day instead of the slot's own. */
  istDayOverride?: string;
}): Promise<DigestRunResult> {
  const { kind } = opts;
  const now = opts.now ?? new Date();

  let settings: DigestSettings;
  try {
    settings = await getDigestSettings(kind);
  } catch (err) {
    return {
      ok: false,
      outcomes: [
        {
          kind: kind.id,
          slot: opts.slot ?? "morning",
          digestDate: "",
          sent: false,
          error: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }

  // ---- Test send: no claim, no due-check, no enabled-check. ----------------
  // A test must work while the digest is switched off — that is when somebody is
  // most likely to be checking the template and the mailbox before turning it on.
  if (opts.slot === "test") {
    const recipients =
      opts.toOverride && opts.toOverride.length > 0 ? opts.toOverride : settings.recipients;
    const digestDate = opts.istDayOverride ?? digestDateForSlot("evening", now);

    const r = await countAndSend(kind, "test", digestDate, recipients, settings);
    await recordTestRun(
      kind.id,
      digestDate,
      opts.triggeredBy,
      recipients,
      r.ok ? "sent" : "failed",
      r.figures,
      r.messageId,
      r.error ?? null,
    );

    return {
      ok: r.ok,
      outcomes: [
        {
          kind: kind.id,
          slot: "test",
          digestDate,
          sent: r.ok,
          figures: r.figures ?? undefined,
          recipients,
          error: r.error,
        },
      ],
    };
  }

  // ---- Real slots ---------------------------------------------------------
  if (!settings.enabled) {
    return {
      ok: true,
      outcomes: [
        {
          kind: kind.id,
          slot: opts.slot ?? "morning",
          digestDate: "",
          sent: false,
          skipped: `switched off in Settings → ${kind.label}`,
        },
      ],
    };
  }

  const targets: Array<{ slot: DigestSlot; digestDate: string }> = opts.slot
    ? [{ slot: opts.slot, digestDate: digestDateForSlot(opts.slot, now) }]
    : slotsDueAt(now, settings);

  if (targets.length === 0) return { ok: true, outcomes: [] };

  const outcomes: DigestRunOutcome[] = [];

  for (const target of targets) {
    const id = await claimSlot(
      kind.id,
      target.slot,
      target.digestDate,
      opts.triggeredBy,
      settings.recipients,
    );

    if (id == null) {
      outcomes.push({
        kind: kind.id,
        slot: target.slot,
        digestDate: target.digestDate,
        sent: false,
        skipped: "already sent, in flight elsewhere, or out of retries",
      });
      continue;
    }

    const r = await countAndSend(
      kind,
      target.slot,
      target.digestDate,
      settings.recipients,
      settings,
    );
    await finishRun(id, r.ok ? "sent" : "failed", r.figures, r.messageId, r.error ?? null);

    outcomes.push({
      kind: kind.id,
      slot: target.slot,
      digestDate: target.digestDate,
      sent: r.ok,
      figures: r.figures ?? undefined,
      recipients: settings.recipients,
      error: r.error,
    });
  }

  return { ok: outcomes.every((o) => o.sent || o.skipped != null), outcomes };
}

/** Run every registered kind. The ticker's and the cron route's default. */
export async function runAllDigests(opts: {
  triggeredBy: DigestTrigger;
  now?: Date;
}): Promise<DigestRunResult> {
  const { DIGEST_KINDS } = await import("./registry");
  const outcomes: DigestRunOutcome[] = [];

  for (const kind of DIGEST_KINDS) {
    // One kind's failure must not stop the next — they are independent mails.
    try {
      const r = await runDigest({ kind, triggeredBy: opts.triggeredBy, now: opts.now });
      outcomes.push(...r.outcomes);
    } catch (err) {
      outcomes.push({
        kind: kind.id,
        slot: "morning",
        digestDate: "",
        sent: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ok: outcomes.every((o) => o.sent || o.skipped != null), outcomes };
}

export type DigestRunRow = {
  id: number;
  kind: string;
  digest_date: string;
  slot: string;
  status: string;
  attempts: number;
  recipients: string | null;
  counts: Record<string, number>;
  triggered_by: string;
  error: string | null;
  created_at: string;
};

/**
 * The most recent sends for one kind, for the settings screen's history panel.
 * Returns an empty list rather than throwing when E-288 has not been applied —
 * the screen should still let an admin configure a digest on a database that
 * cannot yet record one.
 */
export async function recentDigestRuns(kindId: string, limit = 8): Promise<DigestRunRow[]> {
  try {
    const rows = (await db.execute(sql`
      SELECT id, kind, digest_date::text AS digest_date, slot, status, attempts,
             recipients, counts, triggered_by, error, created_at::text AS created_at
        FROM digest_runs
       WHERE kind = ${kindId}
       ORDER BY id DESC
       LIMIT ${limit}
    `)) as unknown as DigestRunRow[];
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error("[digest] failed to read run history:", err);
    return [];
  }
}
