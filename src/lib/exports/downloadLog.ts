// Data download log (tracker ID 58, E-312). Every lead export writes one row:
// who, which dataset, which filters, how many rows. Fail-tolerant by design —
// the table is not in schema.ts and a missing table must never block a
// download, so a failed write logs and returns.

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
}): Promise<void> {
    try {
        await db.execute(sql`
            INSERT INTO data_download_log (user_id, user_role, dataset, row_count, own_only, filters)
            VALUES (${entry.userId}, ${entry.role ?? null}, ${entry.dataset}, ${entry.rowCount},
                    ${entry.ownOnly}, ${JSON.stringify(entry.filters)}::jsonb)
        `);
    } catch (err) {
        console.warn("[downloadLog] could not record download (E-312 applied?)", err);
    }
}
