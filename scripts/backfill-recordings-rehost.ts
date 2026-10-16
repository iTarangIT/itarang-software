/**
 * ID 166 (decision 13: "copy both NeoDove and Bolna recordings into iTarang
 * storage") — copy the recordings that still point at the provider's open
 * link into our call-recordings bucket, and repoint every row that stores
 * that link.
 *
 * New calls are copied as they arrive (finalizeBolnaCall, the legacy Bolna
 * webhook, NeoDove attachCallEvidence). This is for the rows written before:
 *   - ai_call_logs.recording_url     (Bolna / ElevenLabs AI calls)
 *   - bolna_calls.recording_url
 *   - call_records.recording_url     (legacy Bolna pipeline)
 *   - lead_touchpoints.recording_url (NeoDove calls before 13 Oct, AI call touchpoints)
 *
 * DRY RUN BY DEFAULT: lists what it would copy and writes nothing.
 *
 *   node --import tsx --env-file=.env.local scripts/backfill-recordings-rehost.ts
 *   node --import tsx --env-file=.env.local scripts/backfill-recordings-rehost.ts --apply [--limit=50]
 *
 * --apply downloads each recording once (20 s timeout), stores it under the
 * same key a live call would get (<provider>/<call id>.<ext>, so a re-run
 * overwrites rather than duplicates), then UPDATEs every row holding the old
 * link to the new one. A failed download leaves the rows untouched and is
 * listed at the end; a re-run picks up whatever is still on a provider link.
 * It never touches a row already on our own storage.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { isOwnRecordingUrl, rehostRecording } from "@/lib/ai/storage/recordingStore";

const APPLY = process.argv.includes("--apply");
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "0") || 0;

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

type Candidate = { url: string; provider: string; call_id: string; source: string };

async function candidates(): Promise<Candidate[]> {
    // One row per distinct provider link, with the provider and the id the
    // live pipeline would have keyed it by. ai_call_logs first: its call_id is
    // the key finalizeBolnaCall uses.
    const rows = rowsOf<Candidate>(
        await db.execute(sql`
            SELECT DISTINCT ON (url) url, provider, call_id, source FROM (
                SELECT recording_url AS url, COALESCE(provider, 'bolna') AS provider, call_id::text AS call_id, 'ai_call_logs' AS source, 1 AS pri
                  FROM ai_call_logs WHERE recording_url IS NOT NULL AND recording_url <> ''
                UNION ALL
                SELECT recording_url, 'bolna', COALESCE(bolna_call_id, id), 'bolna_calls', 2
                  FROM bolna_calls WHERE recording_url IS NOT NULL AND recording_url <> ''
                UNION ALL
                SELECT recording_url, 'bolna', id, 'call_records', 3
                  FROM call_records WHERE recording_url IS NOT NULL AND recording_url <> ''
                UNION ALL
                SELECT recording_url, COALESCE(external_system, 'neodove'), touchpoint_id::text, 'lead_touchpoints', 4
                  FROM lead_touchpoints WHERE recording_url IS NOT NULL AND recording_url <> ''
            ) x
            WHERE url NOT LIKE '%/api/files/call-recordings/%'
              AND url NOT LIKE '%/storage/v1/object/public/call-recordings/%'
            ORDER BY url, pri
        `),
    );
    return rows.filter((r) => !isOwnRecordingUrl(r.url));
}

async function repoint(oldUrl: string, newUrl: string): Promise<number> {
    let n = 0;
    for (const table of ["ai_call_logs", "bolna_calls", "call_records", "lead_touchpoints"] as const) {
        const res = rowsOf<{ n: number }>(
            await db.execute(sql`
                WITH u AS (
                    UPDATE ${sql.identifier(table)} SET recording_url = ${newUrl}
                     WHERE recording_url = ${oldUrl}
                    RETURNING 1
                ) SELECT count(*)::int AS n FROM u
            `),
        );
        n += res[0]?.n ?? 0;
    }
    return n;
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`database host: ${host}`);
    console.log(APPLY ? "MODE: --apply (copies and repoints)\n" : "MODE: dry run (writes nothing; pass --apply to copy)\n");

    const all = await candidates();
    const bySource = new Map<string, number>();
    const byProvider = new Map<string, number>();
    for (const c of all) {
        bySource.set(c.source, (bySource.get(c.source) ?? 0) + 1);
        byProvider.set(c.provider, (byProvider.get(c.provider) ?? 0) + 1);
    }
    console.log(`recordings still on a provider link: ${all.length}`);
    for (const [k, v] of bySource) console.log(`  first seen in ${k}: ${v}`);
    for (const [k, v] of byProvider) console.log(`  provider ${k}: ${v}`);

    const work = LIMIT ? all.slice(0, LIMIT) : all;
    if (!APPLY) {
        for (const c of work.slice(0, 10)) {
            console.log(`  would copy ${c.provider}/${c.call_id}  <-  ${c.url.replace(/\?.*$/, "?…")}`);
        }
        if (work.length > 10) console.log(`  … and ${work.length - 10} more`);
        return;
    }

    let copied = 0;
    let rowsRepointed = 0;
    const failed: Candidate[] = [];
    for (const c of work) {
        const next = await rehostRecording({ provider: c.provider, callId: c.call_id, recordingUrl: c.url });
        if (!next || !isOwnRecordingUrl(next)) {
            failed.push(c);
            continue;
        }
        copied++;
        rowsRepointed += await repoint(c.url, next);
    }
    console.log(`\ncopied ${copied} of ${work.length}; rows repointed: ${rowsRepointed}`);
    if (failed.length) {
        console.log(`not copied (${failed.length}) — the provider link no longer downloads, or storage refused:`);
        for (const f of failed.slice(0, 20)) console.log(`  ${f.source} ${f.provider}/${f.call_id}`);
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
