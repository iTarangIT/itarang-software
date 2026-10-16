// POST /api/admin/leads/interest-upload — A33: set Hot / Warm / Cold on many
// leads from a CSV. Body: { csv: string, apply?: boolean }. Without `apply`
// it is a preview: every row resolved to a lead and checked, nothing written.
// With `apply`, each valid row goes through setInterestLevel — audited in
// interest_level_overrides like a manual change, reason "Bulk upload".
//
// A phone that matches more than one active lead is refused (ambiguous), never
// guessed. Admin, Sales Head and the CEO.

import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { parseInterestCsv } from "@/lib/leads/interestUpload";
import { setInterestLevel } from "@/lib/leads/interestLevel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ csv: z.string().max(2_000_000), apply: z.boolean().optional() });

type Outcome = { line: number; lead_id: string | null; dealer: string | null; from: string | null; to: string | null; result: string };

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(["admin", "sales_head", "ceo"]);
    const b = Body.parse(await req.json());
    const parsed = parseInterestCsv(b.csv);
    if (parsed.error && !parsed.rows.length) return errorResponse(parsed.error, 400);

    const ids = [...new Set(parsed.rows.map((r) => r.leadId).filter((x): x is string => !!x))];
    const phones = [...new Set(parsed.rows.filter((r) => !r.leadId).map((r) => r.phone).filter((x): x is string => !!x))];
    const found = (await db.execute(sql`
        SELECT dl.id, COALESCE(dl.shop_name, dl.dealer_name) AS dealer, lower(dl.interest_level) AS level,
               right(regexp_replace(COALESCE(dl.phone, ''), '[^0-9]', '', 'g'), 10) AS p10
          FROM dealer_leads dl
         WHERE dl.is_active IS NOT FALSE
           AND (${ids.length ? sql`dl.id IN ${ids}` : sql`FALSE`}
                OR ${phones.length ? sql`right(regexp_replace(COALESCE(dl.phone, ''), '[^0-9]', '', 'g'), 10) IN ${phones}` : sql`FALSE`})
    `)) as unknown as Array<{ id: string; dealer: string | null; level: string | null; p10: string }>;
    const byId = new Map(found.map((f) => [f.id, f]));
    const byPhone = new Map<string, typeof found>();
    for (const f of found) byPhone.set(f.p10, [...(byPhone.get(f.p10) ?? []), f]);

    const out: Outcome[] = [];
    let changed = 0, same = 0, refused = 0;
    for (const r of parsed.rows) {
        if (r.error) {
            refused++;
            out.push({ line: r.line, lead_id: r.leadId, dealer: null, from: null, to: r.level, result: r.error });
            continue;
        }
        const hits = r.leadId ? (byId.get(r.leadId) ? [byId.get(r.leadId)!] : []) : (byPhone.get(r.phone!) ?? []);
        if (hits.length !== 1) {
            refused++;
            out.push({
                line: r.line, lead_id: r.leadId, dealer: null, from: null, to: r.level,
                result: hits.length ? `Phone matches ${hits.length} leads — use lead_id` : "No active lead found",
            });
            continue;
        }
        const lead = hits[0];
        if (lead.level === r.level) {
            same++;
            out.push({ line: r.line, lead_id: lead.id, dealer: lead.dealer, from: lead.level, to: r.level, result: "Already " + r.level });
            continue;
        }
        if (b.apply) {
            await setInterestLevel({ leadId: lead.id, actorId: user.id, level: r.level!, reason: "Bulk upload (A33)" });
        }
        changed++;
        out.push({ line: r.line, lead_id: lead.id, dealer: lead.dealer, from: lead.level, to: r.level, result: b.apply ? "Changed" : "Will change" });
    }
    return successResponse({ applied: Boolean(b.apply), changed, same, refused, rows: out.slice(0, 500), more: out.length > 500 });
});
