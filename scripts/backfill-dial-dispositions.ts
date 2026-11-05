// Dispositions v3 for past AI dials (E-373), and the readout those days give.
//
//   node --import tsx --env-file=.env.local scripts/backfill-dial-dispositions.ts \
//        --from=2026-10-21 --to=2026-11-04 [--apply] [--no-api] [--cache=<file.json>]
//
// Every ElevenLabs campaign dial between the two IST days (attempt_history,
// one entry per dial) is mapped with the live rules (dispositionV3.ts), from:
//   - the entry's own status / outcome (SIP code, early hang-up, …),
//   - the call log (transcript, duration, termination reason, analysis signals),
//   - the conversation's data collection from the ElevenLabs API (answered_by,
//     call_result, callback_agreed, call_language) and its turn timings —
//     unless --no-api (then only what the CRM stored; older agents had none).
//
// Dry run (default): prints the readout per day and the rule counts — the
// check against the tracker's daily readout table. --apply inserts the rows
// (ON CONFLICT DO NOTHING: a live row always wins) and does NOT apply effects
// (no number marks, no counters — history must not retire numbers today).
// Read-only otherwise; safe to dry-run on production.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { DISPOSITION_V3_VERSION, dispositionForDial } from "../src/lib/ai-dialer/dispositionV3";
import { dealerSpoke } from "../src/lib/ai-dialer/campaignLeadStatus";
import { phoneKey } from "../src/lib/ai-dialer/numberHygiene";
import { readoutLines, readoutRow, readoutTurnsFromProvider, type ReadoutDial } from "../src/lib/ai-dialer/readout/readout";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const from = arg("from");
const to = arg("to") ?? from;
const apply = process.argv.includes("--apply");
const useApi = !process.argv.includes("--no-api");
const cachePath = arg("cache");
if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error("usage: --from=YYYY-MM-DD [--to=YYYY-MM-DD] [--apply] [--no-api] [--cache=file.json]");
}
const rowsOf = <T,>(r: unknown) => (Array.isArray(r) ? (r as T[]) : ((r as { rows: T[] }).rows ?? []));

type Conv = {
    answered_by: string | null;
    call_result: string | null;
    callback_agreed: string | null;
    call_language: string | null;
    termination_reason: string | null;
    duration: number | null;
    turns: unknown;
};
const cache: Record<string, Conv | null> = cachePath && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};

async function conversation(id: string): Promise<Conv | null> {
    if (id in cache) return cache[id];
    if (!useApi || !process.env.ELEVENLABS_API_KEY) return null;
    const base = process.env.ELEVENLABS_API_BASE_URL || "https://api.elevenlabs.io";
    const res = await fetch(`${base}/v1/convai/conversations/${id}`, { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } });
    if (!res.ok) {
        cache[id] = null;
        return null;
    }
    const d = (await res.json()) as Record<string, any>;
    const dc = (k: string) => {
        const v = d?.analysis?.data_collection_results?.[k]?.value;
        return v == null || v === "" ? null : String(v);
    };
    cache[id] = {
        answered_by: dc("answered_by"),
        call_result: dc("call_result"),
        callback_agreed: dc("callback_agreed"),
        call_language: dc("call_language"),
        termination_reason: d?.metadata?.termination_reason ?? null,
        duration: typeof d?.metadata?.call_duration_secs === "number" ? d.metadata.call_duration_secs : null,
        turns: d?.transcript ?? null,
    };
    await new Promise((r) => setTimeout(r, 120));
    return cache[id];
}

const KNOWN_OUTCOMES = new Set(["early_hangup", "out_of_service", "invalid_number"]);

async function main() {
    const host = new URL(process.env.DATABASE_URL!).host.split(".")[0];
    console.log(`${host} · ${from} … ${to} · ${apply ? "APPLY" : "dry run"} · ElevenLabs API ${useApi ? "on" : "off"}\n`);
    const dials = rowsOf<{
        row_id: string;
        lead_id: string;
        campaign_id: string;
        phone: string | null;
        n: number | null;
        status: string;
        outcome: string | null;
        at: string;
        call_id: string | null;
        counted: string | null;
    }>(
        await db.execute(sql`
            SELECT dcl.id AS row_id, dcl.lead_id, dcl.campaign_id, dl.phone,
                   (h.value ->> 'n')::int AS n, h.value ->> 'status' AS status, h.value ->> 'outcome' AS outcome,
                   h.value ->> 'at' AS at, NULLIF(h.value ->> 'call_id', '') AS call_id, h.value ->> 'counted' AS counted
              FROM dialer_campaign_leads dcl
              JOIN dialer_campaigns c ON c.id = dcl.campaign_id AND c.provider = 'elevenlabs'
              LEFT JOIN dealer_leads dl ON dl.id = dcl.lead_id
             CROSS JOIN LATERAL jsonb_array_elements(COALESCE(dcl.attempt_history, '[]'::jsonb)) h
             WHERE ((h.value ->> 'at')::timestamptz AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date
             ORDER BY (h.value ->> 'at')::timestamptz
        `),
    );
    console.log(`${dials.length} dials found\n`);

    const byDay = new Map<string, ReadoutDial[]>();
    const rules = new Map<string, number>();
    let inserted = 0;
    for (const x of dials) {
        const log = x.call_id
            ? rowsOf<{ transcript: string | null; call_duration: string | null; end_reason: string | null; callback_agreed: string | null; callback_when: string | null }>(
                  await db.execute(sql`
                      SELECT transcript, call_duration::text, to_jsonb(acl) ->> 'end_reason' AS end_reason,
                             signals ->> 'callback_agreed' AS callback_agreed, signals ->> 'callback_when' AS callback_when
                        FROM ai_call_logs acl WHERE call_id = ${x.call_id} LIMIT 1
                  `),
              )[0]
            : undefined;
        const conv = x.call_id ? await conversation(x.call_id) : null;
        const failure = /^trigger_|sip/i.test(x.outcome ?? "") ? x.outcome : null;
        const { d, input } = dispositionForDial({
            callEnd: { status: x.status, outcome: KNOWN_OUTCOMES.has(x.outcome ?? "") ? x.outcome : null },
            failureText: failure,
            answeredBy: conv?.answered_by ?? null,
            callResult: conv?.call_result ?? null,
            callbackAgreed: conv?.callback_agreed ?? null,
            analysisCallbackAgreed: log?.callback_agreed === "yes",
            analysisCallbackWhen: log?.callback_when ?? null,
            callLanguage: conv?.call_language ?? null,
            terminationReason: conv?.termination_reason ?? log?.end_reason ?? null,
            durationSecs: conv?.duration ?? log?.call_duration ?? null,
            transcript: log?.transcript ?? null,
            dealerSpoke: dealerSpoke(log?.transcript ?? null),
        });
        const day = new Date(new Date(x.at).getTime() + 330 * 60_000).toISOString().slice(0, 10);
        const list = byDay.get(day) ?? [];
        list.push({
            direction: "outbound",
            l1: d.l1,
            l2: d.l2,
            l3: d.l3,
            rule: d.rule,
            durationSecs: input.durationSecs ?? null,
            transcript: log?.transcript ?? null,
            turns: readoutTurnsFromProvider(conv?.turns),
            callLanguage: conv?.call_language ?? null,
        });
        byDay.set(day, list);
        rules.set(d.rule, (rules.get(d.rule) ?? 0) + 1);

        if (apply) {
            const dialKey = x.call_id ?? `trigger:${x.row_id}:${x.n ?? 1}`;
            const r = rowsOf<{ k: string }>(
                await db.execute(sql`
                    INSERT INTO ai_dial_dispositions (
                        dial_key, lead_id, campaign_id, phone_key, direction, l1, l2, l3, rule_no, rules_version,
                        sip_code, answered_by, call_result, callback_agreed, call_language, ended_by, end_reason_raw,
                        duration_secs, effects, dialled_at
                    ) VALUES (
                        ${dialKey}, ${x.lead_id}, ${x.campaign_id}, ${phoneKey(x.phone)}, 'outbound', ${d.l1}, ${d.l2}, ${d.l3},
                        ${d.rule}, ${DISPOSITION_V3_VERSION + "+backfill"}, ${d.sipCode}, ${conv?.answered_by ?? null},
                        ${conv?.call_result ?? null}, ${input.callbackAgreed}, ${conv?.call_language ?? null},
                        ${input.endedBy ?? null}, ${conv?.termination_reason ?? log?.end_reason ?? null}, ${input.durationSecs},
                        ${JSON.stringify(d.effects)}::jsonb, ${x.at}::timestamptz
                    )
                    ON CONFLICT (dial_key) DO NOTHING
                    RETURNING dial_key AS k
                `),
            );
            inserted += r.length;
        }
    }

    const days = [...byDay.keys()].sort().reverse();
    const readout = days.map((day) => readoutRow({ day, dials: byDay.get(day)!, inbound: { total: 0, answered: 0 } }));
    console.log(readoutLines(readout, { version: "(backfill)", changeTested: "—" }).join("\n"));
    console.log("\nRule counts:", [...rules.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}:${n}`).join("  "));
    if (apply) console.log(`\ninserted ${inserted} rows (existing rows kept)`);
    if (cachePath) writeFileSync(cachePath, JSON.stringify(cache));
}

main()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(() => process.exit());
