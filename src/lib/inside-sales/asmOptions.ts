// Active ASMs with a territory-match flag for a dealer's state/city (BRD §0.8).
// Extracted from GET /api/inside-sales/asm-options so the Transfer-to-ASM
// dropdown and the WhatsApp Assistant pick from the same list.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { AsmOption } from "@/lib/inside-sales/types";

export async function listAsmOptions(args: {
    state?: string | null;
    city?: string | null;
    includeOutOfTerritory?: boolean;
}): Promise<{ asms: AsmOption[]; total_asms: number }> {
    const state = args.state ?? null;
    const city = args.city ?? null;
    const rows = await db.execute<{
        user_id: string;
        name: string | null;
        email: string;
        in_territory: boolean;
    }>(sql`
        SELECT
            u.id::text AS user_id,
            u.name,
            u.email,
            EXISTS (
                SELECT 1 FROM asm_territories t
                WHERE t.asm_id = u.id::text
                  AND (${state}::text IS NULL OR t.state = ${state})
                  AND (
                      ${city}::text IS NULL
                      OR t.city IS NULL
                      OR t.city = ${city}
                  )
                  AND (t.active_from IS NULL OR t.active_from <= CURRENT_DATE)
                  AND (t.active_to IS NULL OR t.active_to >= CURRENT_DATE)
            ) AS in_territory
        FROM users u
        WHERE LOWER(u.role) = 'asm' AND u.is_active = TRUE
        ORDER BY u.name ASC
    `);

    const asms: AsmOption[] = rows.map((r) => ({
        user_id: r.user_id,
        name: r.name,
        email: r.email,
        in_territory: Boolean(r.in_territory),
    }));

    return {
        asms: args.includeOutOfTerritory ? asms : asms.filter((a) => a.in_territory),
        total_asms: asms.length,
    };
}
