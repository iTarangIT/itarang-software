/**
 * The 08:00 Fleet Monitor send.
 *
 * Fetch the same data /monitor shows, render it as a phone-shaped card, and
 * post it to Telegram with a caption carrying the headline numbers. When the
 * telemetry database is unreachable, post one line of text instead — a picture
 * of an empty dashboard says less, and silence says nothing at all.
 *
 * THE CLAIM. This reuses the `digest_runs` table rather than inventing one:
 * `kind` there is a plain varchar with no enum or foreign key, and the unique
 * index is partial on slot IN ('morning','evening'), so kind='monitor_morning'
 * fits with NO MIGRATION. That matters more than it sounds — Drizzle names
 * every column in its SQL, so a new table that shipped ahead of its migration
 * would break this job on whichever database had not had it applied.
 *
 * The claim SQL is spelled out here rather than imported from
 * src/lib/digests/engine.ts because that module's claimSlot is private and its
 * surrounding contract is email-shaped (ActivityLine, recipients, an Excel
 * attachment per worksheet). Borrowing the durable part — the table and its
 * index — without the email machinery is the smaller coupling.
 */
import { sql } from "drizzle-orm";

import { renderPngFromHtml } from "@/lib/pdf/render-html";
import { buildMorningCaption, buildUnreachableMessage } from "@/lib/monitor/morning-caption";
import { renderMorningCard } from "@/lib/monitor/morning-card";
import { istSlotState, type Slot } from "@/lib/monitor/schedule";
import { sendMessage, sendPhoto, telegramConfig } from "@/lib/telegram/client";
import { fetchMonitorOverview, fetchMonitorPeriods } from "@/lib/telemetry/monitor-queries";
import { isVpsUnreachable, vpsDegradedReason } from "@/lib/telemetry/vps-status";

const KIND = "monitor_morning";
const SLOT_NAME = "morning";
const MAX_ATTEMPTS = 3;
/** A row left in 'sending' this long is assumed to be a process that died. */
const STUCK_CLAIM_MINUTES = 20;

export const DEFAULT_SLOT: Slot = { hour: 8, minute: 0 };

/** 08:00 IST by default; MONITOR_MORNING_AT="7:30" overrides it. */
export function configuredSlot(): Slot {
    const raw = process.env.MONITOR_MORNING_AT?.trim();
    if (!raw) return DEFAULT_SLOT;
    const m = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return DEFAULT_SLOT;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) return DEFAULT_SLOT;
    return { hour, minute };
}

export type MonitorReportOutcome =
    | { sent: false; reason: "not_configured" | "not_due" | "already_claimed" }
    | { sent: true; kind: "card" | "unreachable_notice"; istDate: string; messageId: number }
    | { sent: false; reason: "failed"; error: string };

/**
 * Take the slot for `istDate`, or return null if someone else already has it.
 *
 * A failed row is re-claimable while attempts remain; a row stuck in 'sending'
 * is re-claimable once it is clearly abandoned. Both conditions live in the
 * WHERE of the ON CONFLICT, so the decision is atomic — two processes ticking
 * at the same second can only ever split the work, never duplicate it.
 */
async function claim(istDate: string, triggeredBy: string): Promise<number | null> {
    const { db } = await import("@/lib/db");
    try {
        const rows = (await db.execute(sql`
            INSERT INTO digest_runs
                (kind, digest_date, slot, status, attempts, triggered_by, recipients, claimed_at)
            VALUES
                (${KIND}, ${istDate}::date, ${SLOT_NAME}, 'sending', 1, ${triggeredBy}, 'telegram', now())
            ON CONFLICT (kind, digest_date, slot) WHERE slot IN ('morning', 'evening')
            DO UPDATE SET
                status       = 'sending',
                attempts     = digest_runs.attempts + 1,
                claimed_at   = now(),
                triggered_by = EXCLUDED.triggered_by
            WHERE
                (digest_runs.status = 'failed' AND digest_runs.attempts < ${MAX_ATTEMPTS})
                OR (digest_runs.status = 'sending'
                    AND digest_runs.claimed_at < now() - make_interval(mins => ${STUCK_CLAIM_MINUTES}))
            RETURNING id
        `)) as unknown as Array<{ id: number }>;
        return rows?.[0]?.id ?? null;
    } catch (err) {
        console.error("[monitor:morning] claim failed:", err);
        return null;
    }
}

async function finish(id: number, status: "sent" | "failed", messageId = 0, error?: string) {
    const { db } = await import("@/lib/db");
    try {
        await db.execute(sql`
            UPDATE digest_runs
               SET status = ${status},
                   message_id = ${messageId ? String(messageId) : null},
                   error = ${error ?? null}
             WHERE id = ${id}
        `);
    } catch (err) {
        console.error("[monitor:morning] could not record outcome:", err);
    }
}

export async function runMonitorMorningReport(opts: {
    now?: Date;
    triggeredBy?: "ticker" | "cron" | "manual";
    /** Skip the due check — for a manual send. The claim still applies. */
    force?: boolean;
}): Promise<MonitorReportOutcome> {
    const now = opts.now ?? new Date();
    const triggeredBy = opts.triggeredBy ?? "ticker";

    const cfg = telegramConfig();
    if (!cfg) return { sent: false, reason: "not_configured" };

    const state = istSlotState(now, configuredSlot());
    if (!state.due && !opts.force) return { sent: false, reason: "not_due" };

    const runId = await claim(state.istDate, triggeredBy);
    if (runId === null) return { sent: false, reason: "already_claimed" };

    try {
        let data;
        try {
            data = await fetchMonitorOverview(now);
        } catch (err) {
            if (!isVpsUnreachable(err)) throw err;
            // Unreachable is an OUTCOME, not a failure: the send succeeded, it
            // just carried bad news. Marking it 'failed' would make the ticker
            // retry all morning and post the same warning three times.
            const { messageId } = await sendMessage(
                cfg,
                buildUnreachableMessage(vpsDegradedReason(err), now),
            );
            await finish(runId, "sent", messageId);
            return { sent: true, kind: "unreachable_notice", istDate: state.istDate, messageId };
        }

        // The Total / 30-day grid is an addition to the card, not its point. If
        // its queries fail the morning card still goes out without it, rather
        // than the day's report being lost to a secondary figure.
        const periods = await fetchMonitorPeriods(now).catch((e: unknown) => {
            console.error(
                "[monitor:morning] period grid unavailable:",
                e instanceof Error ? e.message : e,
            );
            return null;
        });

        const png = await renderPngFromHtml(renderMorningCard(data, now, periods), {
            width: 720,
        });
        const { messageId } = await sendPhoto(cfg, png, buildMorningCaption(data, now));

        await finish(runId, "sent", messageId);
        return { sent: true, kind: "card", istDate: state.istDate, messageId };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[monitor:morning] send failed:", message);
        await finish(runId, "failed", 0, message.slice(0, 500));
        return { sent: false, reason: "failed", error: message };
    }
}
