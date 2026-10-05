// Find the application a dealer wants to continue (tracker ID 129) — by its id,
// or by the owner e-mail / dealer code typed into the form. Approved
// applications are never returned: there is nothing to continue.
//
// Server-only (db). The rule about who may then change it is in submitAccess.ts.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

export type ResumableApplication = {
    id: string;
    owner_email: string | null;
    owner_name: string | null;
    company_name: string | null;
    onboarding_status: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function findResumableApplication(input: {
    applicationId?: string | null;
    ownerEmail?: string | null;
    dealerCode?: string | null;
}): Promise<ResumableApplication | null> {
    const rawId = (input.applicationId ?? "").trim();
    const id = UUID_RE.test(rawId) ? rawId : null;
    const email = (input.ownerEmail ?? "").trim().toLowerCase() || null;
    const code = (input.dealerCode ?? "").trim() || null;
    if (!id && !email && !code) return null;

    const rows = (await db.execute(sql`
        SELECT app.id::text AS id, app.owner_email, app.owner_name, app.company_name, app.onboarding_status
          FROM dealer_onboarding_applications app
         WHERE COALESCE(app.onboarding_status, 'draft') <> 'approved'
           AND (
                (${id}::text IS NOT NULL AND app.id::text = ${id}::text)
             OR (${email}::text IS NOT NULL AND lower(btrim(app.owner_email)) = ${email}::text)
             OR (${code}::text IS NOT NULL AND app.dealer_code = ${code}::text)
           )
         ORDER BY (app.id::text = COALESCE(${id}::text, '')) DESC, app.updated_at DESC
         LIMIT 1
    `)) as unknown as ResumableApplication[];
    return rows[0] ?? null;
}

/** True for Postgres "relation does not exist" — E-330 not applied on this database. */
export function isMissingTable(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string }; message?: string } | null;
    return (
        e?.code === "42P01" ||
        e?.cause?.code === "42P01" ||
        /dealer_onboarding_resume_otps.*does not exist/i.test(e?.message ?? "")
    );
}
