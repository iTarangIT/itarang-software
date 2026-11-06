// ID 221 (decided 3 Nov, Kartik) — the people a lead can be given to by name:
// an owner's active direct reports, or (ID 155) a manager and their team.
// Shared by the Reassign picker on the ISR and ASM lead pages and by the
// WhatsApp assistant's reassign, so both offer and accept the same people.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { getTeamMemberIds } from "@/lib/users/team";
import { territoryText } from "@/lib/users/teamRules";

export type TeamTarget = { id: string; name: string; role: string; territory: string; is_self: boolean };

type Row = { id: string; name: string | null; role: string | null; is_active: boolean | null };
type Place = { asm_id: string; state: string | null; city: string | null };

/** The people `ids` as picker rows (active only), self first then by name. */
export async function teamTargetsFor(ids: readonly string[], selfId: string): Promise<TeamTarget[]> {
    if (!ids.length) return [];
    const list = sql.join(ids.map((id) => sql`${id}`), sql`, `);
    const [people, places] = await Promise.all([
        db.execute(sql`
            SELECT id::text AS id, name, role, is_active FROM users WHERE id::text IN (${list})
        `) as unknown as Promise<Row[]>,
        db.execute(sql`
            SELECT t.asm_id, t.state, t.city
              FROM asm_territories t
             WHERE t.asm_id IN (${list})
               AND (t.active_from IS NULL OR t.active_from <= CURRENT_DATE)
               AND (t.active_to IS NULL OR t.active_to >= CURRENT_DATE)
             ORDER BY t.state, t.city
        `).catch(() => []) as unknown as Promise<Place[]>,
    ]);
    const placesOf = new Map<string, Place[]>();
    for (const p of places) placesOf.set(p.asm_id, [...(placesOf.get(p.asm_id) ?? []), p]);
    return people
        .filter((p) => p.is_active !== false)
        .map((p) => ({
            id: p.id,
            name: p.name ?? p.id,
            role: p.role ?? "",
            territory: territoryText(p.role, placesOf.get(p.id) ?? []),
            is_self: p.id === selfId,
        }))
        .sort((a, b) => Number(b.is_self) - Number(a.is_self) || a.name.localeCompare(b.name));
}

/** An owner's ACTIVE direct reports (the only people they may give a lead to). */
export async function activeReportTargets(ownerId: string): Promise<TeamTarget[]> {
    const ids = (await getTeamMemberIds(ownerId)).filter((id) => id !== ownerId);
    return teamTargetsFor(ids, ownerId);
}
