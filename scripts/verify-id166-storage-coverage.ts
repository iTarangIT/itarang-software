/**
 * Read-only: is every stored file the database points at actually in S3, and
 * could the old-storage fallback (STORAGE_SUPABASE_FALLBACK) still serve
 * anything? Tracker ID 166, "remove the old-storage fallback".
 *
 *   AWS_S3_BUCKET=<bucket> node --import tsx --env-file=.env.local scripts/verify-id166-storage-coverage.ts
 *
 * Which bucket goes with which database (from .env.local):
 *   database-1 (sandbox) -> itarang-crm-storage
 *   database-2 (prod)    -> itarang-crm-production
 *
 * What it does, all reads:
 *   1. every text / varchar / json / jsonb column in `public` is searched for
 *      files-proxy paths (/api/files/<bucket>/<key>) and Supabase storage URLs
 *      (…/storage/v1/object/(public|sign|authenticated)/<bucket>/<key>);
 *   2. each distinct object is checked with S3 HeadObject in AWS_S3_BUCKET
 *      (a Supabase URL is checked at the key the migration copied it to — the
 *      same <bucket>/<key> — which is where readStoredDocument reads it);
 *   3. the Supabase project the app is configured with is asked which storage
 *      buckets it has (listBuckets) — the only place the fallback could read.
 *
 * Env: MAX_HEAD caps the HeadObject checks (default: all, sampled evenly when
 * capped). Writes nothing anywhere.
 */
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

type Ref = { kind: "proxy" | "supabase"; bucket: string; key: string; host?: string };

const PROXY_RE = /\/api\/files\/([a-z0-9-]+)\/([^\s"'<>?#\\]+)/g;
const SUPA_RE = /https?:\/\/([a-z0-9-]+)\.supabase\.co\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/\s"'<>]+)\/([^\s"'<>?#\\]+)/g;

function decode(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}
const keyOf = (raw: string) => raw.split("/").map(decode).join("/").replace(/\/+$/, "");

async function main() {
    const url = process.env.DATABASE_URL;
    const bucket = process.env.AWS_S3_BUCKET;
    if (!url || !bucket) throw new Error("DATABASE_URL and AWS_S3_BUCKET must be set");
    const host = url.replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`database host : ${host}`);
    console.log(`S3 bucket     : ${bucket}`);

    const sql = postgres(url, { max: 1, ssl: "require", prepare: false }); // one connection, so the read-only setting below covers every query
    try {
        await sql`SET default_transaction_read_only = on`;
        const cols = await sql<{ t: string; c: string }[]>`
            SELECT c.table_name AS t, c.column_name AS c
              FROM information_schema.columns c
              JOIN information_schema.tables tb
                ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
             WHERE c.table_schema = 'public'
               AND c.data_type IN ('text', 'character varying', 'json', 'jsonb')
             ORDER BY 1, 2`;
        console.log(`columns scanned: ${cols.length}`);

        const refs = new Map<string, Ref & { rows: number; columns: Set<string> }>();
        const perColumn: { col: string; rows: number; proxy: number; supabase: number }[] = [];
        let nbfcUploads = 0;
        for (const { t, c } of cols) {
            let rows: { v: string }[];
            try {
                rows = await sql.unsafe(
                    `SELECT "${c}"::text AS v FROM "${t}" WHERE "${c}"::text LIKE '%/api/files/%' OR "${c}"::text LIKE '%/storage/v1/object/%' OR "${c}"::text LIKE '%/api/nbfc-uploads/%'`,
                );
            } catch (err) {
                console.warn(`  skip ${t}.${c}: ${err instanceof Error ? err.message : err}`);
                continue;
            }
            if (rows.length === 0) continue;
            let proxy = 0;
            let supa = 0;
            for (const { v } of rows) {
                if (v.includes("/api/nbfc-uploads/")) nbfcUploads++;
                for (const m of v.matchAll(PROXY_RE)) {
                    const r: Ref = { kind: "proxy", bucket: m[1], key: keyOf(m[2]) };
                    const id = `${r.bucket}/${r.key}`;
                    const e = refs.get(id) ?? { ...r, rows: 0, columns: new Set<string>() };
                    e.rows++;
                    e.columns.add(`${t}.${c}`);
                    refs.set(id, e);
                    proxy++;
                }
                for (const m of v.matchAll(SUPA_RE)) {
                    const r: Ref = { kind: "supabase", host: m[1], bucket: decode(m[2]), key: keyOf(m[3]) };
                    const id = `supabase:${r.host}:${r.bucket}/${r.key}`;
                    const e = refs.get(id) ?? { ...r, rows: 0, columns: new Set<string>() };
                    e.rows++;
                    e.columns.add(`${t}.${c}`);
                    refs.set(id, e);
                    supa++;
                }
            }
            perColumn.push({ col: `${t}.${c}`, rows: rows.length, proxy, supabase: supa });
        }

        console.log(`\nreferencing columns (rows / proxy refs / supabase refs):`);
        for (const p of perColumn.sort((a, b) => b.rows - a.rows)) {
            console.log(`  ${p.col.padEnd(60)} ${String(p.rows).padStart(6)} ${String(p.proxy).padStart(6)} ${String(p.supabase).padStart(6)}`);
        }
        console.log(`(/api/nbfc-uploads references, other route, not checked: ${nbfcUploads})`);

        const all = [...refs.values()];
        const proxyRefs = all.filter((r) => r.kind === "proxy");
        const supaRefs = all.filter((r) => r.kind === "supabase");
        const supaHosts = new Map<string, number>();
        for (const r of supaRefs) supaHosts.set(r.host!, (supaHosts.get(r.host!) ?? 0) + 1);
        console.log(`\ndistinct objects referenced: ${all.length}  (files-proxy ${proxyRefs.length}, Supabase URL ${supaRefs.length})`);
        for (const [h, n] of supaHosts) console.log(`  Supabase project ${h}: ${n} distinct objects`);

        // HeadObject in S3.
        const s3 = new S3Client({
            region: process.env.AWS_REGION,
            credentials:
                process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
                    ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
                    : undefined,
        });
        const cap = Number(process.env.MAX_HEAD) || all.length;
        const step = all.length > cap ? all.length / cap : 1;
        const sample = all.length > cap ? Array.from({ length: cap }, (_, i) => all[Math.floor(i * step)]) : all;
        const missing: typeof all = [];
        let present = 0;
        let errors = 0;
        let i = 0;
        async function worker() {
            while (i < sample.length) {
                const r = sample[i++];
                const Key = `${r.bucket}/${r.key}`.replace(/\/{2,}/g, "/");
                try {
                    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key }));
                    present++;
                } catch (err) {
                    const code = (err as { name?: string; $metadata?: { httpStatusCode?: number } });
                    if (code.name === "NotFound" || code.$metadata?.httpStatusCode === 404) missing.push(r);
                    else {
                        errors++;
                        if (errors <= 3) console.warn(`  HeadObject error ${Key}: ${code.name}`);
                    }
                }
            }
        }
        await Promise.all(Array.from({ length: 16 }, worker));
        console.log(`\nS3 HeadObject checked ${sample.length}${sample.length < all.length ? ` (sampled of ${all.length})` : ""}: present ${present}, missing ${missing.length}, errors ${errors}`);
        const byFolder = new Map<string, number>();
        for (const r of missing) {
            const f = `${r.kind}:${r.bucket}/${r.key.split("/")[0]}`;
            byFolder.set(f, (byFolder.get(f) ?? 0) + 1);
        }
        if (missing.length) {
            console.log(`missing by bucket/top folder:`);
            for (const [f, n] of [...byFolder].sort((a, b) => b[1] - a[1])) console.log(`  ${f.padEnd(50)} ${n}`);
            const missingRows = missing.reduce((s, r) => s + r.rows, 0);
            console.log(`rows pointing at a missing object: ${missingRows}`);
            console.log(`examples:`);
            for (const r of missing.slice(0, 8)) console.log(`  ${r.kind} ${r.bucket}/${r.key}  <- ${[...r.columns].join(", ")}`);
        }

        // What the fallback could read: the Supabase project the app points at.
        const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        console.log(`\nfallback target: ${supaUrl ?? "(NEXT_PUBLIC_SUPABASE_URL unset)"}`);
        console.log(`STORAGE_SUPABASE_FALLBACK here: ${process.env.STORAGE_SUPABASE_FALLBACK || "(unset = off)"}`);
        if (supaUrl && supaKey) {
            const sb = createClient(supaUrl, supaKey, { auth: { persistSession: false } });
            const { data, error } = await sb.storage.listBuckets();
            if (error) console.log(`  listBuckets error: ${error.message}`);
            else console.log(`  storage buckets in that project: ${data.length}${data.length ? ` (${data.map((b) => b.name).join(", ")})` : ""}`);
            const configuredHost = new URL(supaUrl).hostname.split(".")[0];
            const servable = missing.filter((r) => r.kind === "supabase" && r.host === configuredHost).length;
            console.log(`  missing objects whose Supabase URL names that project: ${servable}`);
        }
    } finally {
        await sql.end();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
