// Data download log (tracker IDs 58 and 13, E-312 + E-324). Every download
// writes one row: who, which dataset, which filters, how many rows, and — since
// E-324 — whether it carried full phone numbers, the reason given, the format.
// Fail-tolerant by design — the table is not in schema.ts and a missing table
// must never block a download, so a failed write logs and returns.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// The own-leads rule lives in lib/leads/access.ts (client-safe — the screens
// read it to decide whether to show an export button); re-exported here so the
// export routes keep one import for "who is limited" and "log it".
export { OWN_LEADS_EXPORT_ROLES, exportsOwnLeadsOnly } from "@/lib/leads/access";

export async function logDataDownload(entry: {
    userId: string;
    role: string | null | undefined;
    dataset: string;
    rowCount: number;
    ownOnly: boolean;
    filters: Record<string, unknown>;
    /** E-324. Omitted by the older exports, which log masking inside `filters`. */
    fullPhone?: boolean;
    reason?: string | null;
    format?: "xlsx" | "csv";
}): Promise<void> {
    const filters = JSON.stringify(entry.filters);
    try {
        await db.execute(sql`
            INSERT INTO data_download_log
                (user_id, user_role, dataset, row_count, own_only, filters, full_phone, reason, format)
            VALUES (${entry.userId}, ${entry.role ?? null}, ${entry.dataset}, ${entry.rowCount},
                    ${entry.ownOnly}, ${filters}::jsonb, ${entry.fullPhone === true},
                    ${entry.reason ?? null}, ${entry.format ?? null})
        `);
        return;
    } catch {
        // A host without E-324: fall through to the E-312 columns, keeping the
        // new facts inside `filters` so nothing about the download is lost.
    }
    try {
        const merged = JSON.stringify({
            ...entry.filters,
            ...(entry.fullPhone !== undefined ? { full_phone: entry.fullPhone } : {}),
            ...(entry.reason ? { reason: entry.reason } : {}),
            ...(entry.format ? { format: entry.format } : {}),
        });
        await db.execute(sql`
            INSERT INTO data_download_log (user_id, user_role, dataset, row_count, own_only, filters)
            VALUES (${entry.userId}, ${entry.role ?? null}, ${entry.dataset}, ${entry.rowCount},
                    ${entry.ownOnly}, ${merged}::jsonb)
        `);
    } catch (err) {
        console.warn("[downloadLog] could not record download (E-312 applied?)", err);
    }
}

export type DownloadLogRow = {
    id: string;
    created_at: string;
    user_name: string | null;
    user_role: string | null;
    dataset: string;
    row_count: number;
    own_only: boolean;
    full_phone: boolean;
    reason: string | null;
    format: string | null;
    filters: Record<string, unknown>;
};

/**
 * The most recent downloads, newest first. Admin and CEO see everyone's; pass
 * `userId` for the list anyone else sees — their own downloads only.
 */
export async function listDataDownloads(limit = 200, userId?: string): Promise<DownloadLogRow[]> {
    try {
        const rows = (await db.execute(sql`
            SELECT l.id::text AS id, l.created_at::text AS created_at, u.name AS user_name, l.user_role,
                   l.dataset, l.row_count, l.own_only, l.filters,
                   COALESCE((to_jsonb(l) ->> 'full_phone')::boolean,
                            (l.filters ->> 'full_phone')::boolean,
                            NOT COALESCE((l.filters ->> 'phone_masked')::boolean, true)) AS full_phone,
                   COALESCE(to_jsonb(l) ->> 'reason', l.filters ->> 'reason')           AS reason,
                   COALESCE(to_jsonb(l) ->> 'format', l.filters ->> 'format')           AS format
              FROM data_download_log l
              LEFT JOIN users u ON u.id::text = l.user_id::text
             ${userId ? sql`WHERE l.user_id::text = ${userId}` : sql``}
             ORDER BY l.created_at DESC
             LIMIT ${limit}
        `)) as unknown as Array<Record<string, unknown>>;
        return rows.map((r) => ({
            id: String(r.id),
            created_at: String(r.created_at),
            user_name: (r.user_name as string | null) ?? null,
            user_role: (r.user_role as string | null) ?? null,
            dataset: String(r.dataset),
            row_count: Number(r.row_count ?? 0),
            own_only: r.own_only === true,
            full_phone: r.full_phone === true,
            reason: (r.reason as string | null) ?? null,
            format: (r.format as string | null) ?? null,
            filters: (r.filters as Record<string, unknown>) ?? {},
        }));
    } catch (err) {
        console.warn("[downloadLog] could not read the log (E-312 applied?)", err);
        return [];
    }
}
