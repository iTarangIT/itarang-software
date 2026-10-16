// ID 183 — "Assisted by (iTarang)" on a customer file: the iTarang people who
// did steps on it for the dealer. Read from the ACTED_FOR_DEALER audit rows the
// act-for-dealer gate writes ("Done by <name> for <dealer>",
// src/lib/leads/actForDealerGuard.ts recordActorStep). The dealer keeps the
// credit for the file; this column only shows who helped.
//
// Used by the Customer loan files download, the KYC export and the KYC review
// digest. No db import: the digest registry imports this at module scope.

import { sql, type SQL } from "drizzle-orm";

import { ACTED_FOR_DEALER } from "@/lib/leads/actForDealer";

export interface AssistedBy {
    /** Distinct people, A–Z. */
    names: string[];
    /** Every step they did on the file. */
    steps: number;
}

/**
 * SQL: json {names, steps} for the lead whose id is `leadId`, or NULL when
 * nobody from iTarang acted for the dealer on it. The name is the user's name
 * today, else the name written on the row.
 */
export function assistedBySql(leadId: SQL): SQL {
    return sql`(SELECT json_build_object(
                    'names', json_agg(DISTINCT COALESCE(NULLIF(afu.name, ''), NULLIF(afd.changes ->> 'by_name', ''), 'iTarang')),
                    'steps', COUNT(*))
                  FROM audit_logs afd
                  LEFT JOIN users afu ON afu.id = afd.performed_by
                 WHERE afd.entity_type = 'lead' AND afd.entity_id = (${leadId})::text
                   AND afd.action = ${ACTED_FOR_DEALER}
                HAVING COUNT(*) > 0)`;
}

/** The SQL value (object or JSON text) → names + steps; null when there is none. */
export function parseAssistedBy(raw: unknown): AssistedBy | null {
    let v: unknown = raw;
    if (typeof v === "string") {
        try {
            v = JSON.parse(v);
        } catch {
            return null;
        }
    }
    if (!v || typeof v !== "object") return null;
    const o = v as { names?: unknown; steps?: unknown };
    const names = Array.isArray(o.names)
        ? Array.from(new Set(o.names.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim())))
        : [];
    const steps = Number(o.steps);
    if (!names.length) return null;
    names.sort((a, b) => a.localeCompare(b));
    return { names, steps: Number.isFinite(steps) && steps > 0 ? Math.floor(steps) : names.length };
}

/** "Asha Rao, Vikram S (3 steps)"; null when nobody helped. */
export function assistedByLabel(raw: unknown): string | null {
    const a = parseAssistedBy(raw);
    if (!a) return null;
    return `${a.names.join(", ")} (${a.steps} step${a.steps === 1 ? "" : "s"})`;
}

/**
 * Digest list rows carry one "subtitle" (the dealer): the KYC review mail adds
 * "Assisted by …" after it — "Shakti Motors · Assisted by Asha Rao (2 steps)".
 */
export function withAssistedBy(subtitle: unknown, raw: unknown): string | null {
    const base = subtitle == null || String(subtitle).trim() === "" ? null : String(subtitle);
    const label = assistedByLabel(raw);
    if (!label) return base;
    return base ? `${base} · Assisted by ${label}` : `Assisted by ${label}`;
}
