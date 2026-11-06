// The nightly AI dialer quality readout (Priya KPI tracker task 5) — the I/O half.
//
//   buildReadout()       one row per IST day from ai_dial_dispositions (E-373),
//                        the call logs (transcripts, turn timings) and
//                        inbound_calls (E-376); newest first
//   runNightlyReadout()  the daily job (19:20 IST): today's row + the last 7
//                        days, emailed to Settings › Dialer alerts
//
// Read-only except for the email. Days before E-373 have no rows until
// scripts/backfill-dial-dispositions.ts has been run for them.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { hasDialDispositionTables } from "@/lib/ai/storage/dialDisposition";
import { hasInboundTable } from "../inbound";
import { getDialerAlertSettings } from "../dialerAlerts";
import { readoutLines, readoutRow, readoutTurnsFromProvider, type ReadoutDial, type ReadoutRow } from "./readout";

function rowsOf<T>(r: unknown): T[] {
    return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);
}

/** IST calendar day `daysAgo` before `now`, YYYY-MM-DD. */
export function istDayAgo(now: Date, daysAgo: number): string {
    return new Date(now.getTime() + 330 * 60_000 - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

/** Every dial (both directions) on one IST day, with what the defect flags need. */
export async function readoutDialsForDay(day: string): Promise<ReadoutDial[]> {
    if (!(await hasDialDispositionTables())) return [];
    const r = rowsOf<{
        direction: string;
        l1: string;
        l2: string;
        l3: string | null;
        rule_no: string;
        duration_secs: string | number | null;
        call_language: string | null;
        transcript: string | null;
        turns: unknown;
    }>(
        await db.execute(sql`
            SELECT d.direction, d.l1, d.l2, d.l3, d.rule_no, d.duration_secs, d.call_language,
                   acl.transcript, to_jsonb(acl) -> 'transcript_turns' AS turns
              FROM ai_dial_dispositions d
              LEFT JOIN ai_call_logs acl ON acl.call_id = d.dial_key
             WHERE (d.dialled_at AT TIME ZONE 'Asia/Kolkata')::date = ${day}::date
        `),
    );
    return r.map((x) => ({
        direction: x.direction === "inbound" ? "inbound" : "outbound",
        l1: x.l1,
        l2: x.l2,
        l3: x.l3,
        rule: x.rule_no,
        durationSecs: x.duration_secs == null ? null : Number(x.duration_secs),
        callLanguage: x.call_language,
        transcript: x.transcript,
        turns: readoutTurnsFromProvider(x.turns),
    }));
}

export async function inboundForDay(day: string): Promise<{ total: number; answered: number }> {
    if (!(await hasInboundTable())) return { total: 0, answered: 0 };
    const r = rowsOf<{ total: number; answered: number }>(
        await db.execute(sql`
            SELECT count(*)::int AS total, count(*) FILTER (WHERE answered)::int AS answered
              FROM inbound_calls
             WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${day}::date
        `),
    )[0];
    return { total: Number(r?.total ?? 0), answered: Number(r?.answered ?? 0) };
}

/** Rows for the last `days` IST days ending today, newest first; days with no dials are skipped. */
export async function buildReadout(now: Date = new Date(), days = 7): Promise<ReadoutRow[]> {
    const out: ReadoutRow[] = [];
    for (let i = 0; i < days; i++) {
        const day = istDayAgo(now, i);
        const [dials, inbound] = await Promise.all([readoutDialsForDay(day), inboundForDay(day)]);
        const row = readoutRow({ day, dials, inbound });
        if (row.dials > 0 || row.inboundTotal > 0 || i === 0) out.push(row);
    }
    return out;
}

/** Everyone on Settings › Dialer alerts, as email addresses (users + extras). */
async function readoutRecipients(): Promise<string[]> {
    const s = await getDialerAlertSettings();
    const users = s.userIds.length
        ? rowsOf<{ email: string }>(
              await db.execute(sql`
                  SELECT lower(trim(email)) AS email FROM users
                   WHERE id::text IN (${sql.join(s.userIds.map((id) => sql`${id}`), sql`, `)})
                     AND is_active IS NOT FALSE AND NULLIF(trim(email), '') IS NOT NULL
              `),
          ).map((u) => u.email)
        : [];
    return [...new Set([...users, ...s.emails])];
}

/** The daily job: build, then email. Returns counts for digest_runs. */
export async function runNightlyReadout(now: Date = new Date()): Promise<Record<string, unknown>> {
    const rows = await buildReadout(now, 7);
    const settings = await getDialerAlertSettings();
    const lines = readoutLines(rows, { version: settings.agentVersion, changeTested: settings.changeTested });
    const today = rows[0];
    const to = await readoutRecipients();
    if (to.length === 0) return { rows: rows.length, sent: 0, note: "no recipients" };
    const { sendEmail } = await import("@/lib/email/mailer");
    const subject = today
        ? `AI dialer readout ${today.day}: ${today.per100 == null ? "no dials" : `${today.per100.toFixed(1)} complete per 100 dials`}`
        : "AI dialer readout";
    const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    await sendEmail({
        to,
        subject,
        text: lines.join("\n"),
        html: `<pre style="font-family:Consolas,Menlo,monospace;font-size:13px">${escape(lines.join("\n"))}</pre>`,
    });
    return {
        rows: rows.length,
        sent: to.length,
        dials: today?.dials ?? 0,
        complete: today?.complete ?? 0,
        per100: today?.per100 ?? null,
    };
}
