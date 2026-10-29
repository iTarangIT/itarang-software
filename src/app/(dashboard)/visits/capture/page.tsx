import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth-utils";
import { leadHrefFor } from "@/lib/leads/newOwnerNotice";
import { getTeamMemberIds } from "@/lib/users/team";
import { mayLogAccountVisit } from "@/lib/visits/verifiedCapture";
import { LeadVisitCapture, AccountVisitCapture } from "./VisitCaptureForms";

export const dynamic = "force-dynamic";

// Tracker ID 196 (PJP phase 1) — log a verified visit from the phone: the
// WhatsApp "log visit" link (?lead=), My Dealers > Log visit (?account=) and
// "I'm at the shop now" on a new lead (?lead=&new=1) all open here. The lead's
// owner logs on a lead; the counter's owner or their manager on an account.
export default async function VisitCapturePage({
    searchParams,
}: {
    searchParams: Promise<{ lead?: string; account?: string }>;
}) {
    const user = await requireAuth();
    const sp = await searchParams;
    const shell = (body: React.ReactNode) => (
        <div className="mx-auto max-w-xl space-y-4 px-4 py-6">
            <h1 className="text-xl font-semibold text-gray-900">Log a visit</h1>
            {body}
        </div>
    );
    const refuse = (msg: string, back: string) =>
        shell(
            <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                {msg}{" "}
                <Link href={back} className="underline">
                    Go back
                </Link>
            </div>,
        );

    if (sp.lead) {
        const [lead] = (await db.execute(sql`
            SELECT id, COALESCE(NULLIF(shop_name, ''), dealer_name, id) AS name, lead_status, interest_level,
                   current_owner_id
              FROM dealer_leads WHERE id = ${sp.lead}
        `)) as unknown as Array<{
            id: string;
            name: string;
            lead_status: string | null;
            interest_level: string | null;
            current_owner_id: string | null;
        }>;
        if (!lead) return refuse("That lead was not found.", "/");
        const back = leadHrefFor(user.role, lead.id);
        if (lead.current_owner_id !== user.id) return refuse("Only the lead's owner can log a visit on it.", back);
        return shell(
            <LeadVisitCapture
                leadId={lead.id}
                name={lead.name}
                lead={{ lead_status: lead.lead_status, interest_level: lead.interest_level }}
                backHref={back}
            />,
        );
    }

    if (sp.account) {
        const [acct] = (await db.execute(sql`
            SELECT a.id, a.business_entity_name AS name, ao.owner_user_id::text AS owner_id
              FROM accounts a LEFT JOIN account_ownership ao ON ao.account_id = a.id
             WHERE a.id = ${sp.account}
        `)) as unknown as Array<{ id: string; name: string; owner_id: string | null }>;
        const back = `/my-dealers/${encodeURIComponent(sp.account)}`;
        if (!acct) return refuse("That counter was not found.", "/my-dealers");
        const ok = mayLogAccountVisit({ userId: user.id, ownerId: acct.owner_id, teamIds: await getTeamMemberIds(user.id) });
        if (!ok) return refuse("Only this counter's owner, or their manager, can log a visit here.", back);
        return shell(<AccountVisitCapture accountId={acct.id} name={acct.name} backHref={back} />);
    }

    return refuse("Open this page from a lead or a counter.", "/");
}
