// /ceo/analyst/verified — the AI Analyst's verified queries (E-382). Each was marked from an
// answer by the CEO, the Sales Head or an admin; a new question close to one is answered from
// its SQL, and an answer that runs one shows a "Verified" badge. Unverify takes one back.

import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { VerifiedQueryRow } from "@/components/analyst/VerifiedQueryRow";
import { requireRole } from "@/lib/auth-utils";
import { hasVerifiedTable, listVerified } from "@/lib/analyst/verifiedStore";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI Analyst verified queries" };

export default async function AnalystVerifiedPage() {
    await requireRole(["ceo", "admin"]);
    const ready = await hasVerifiedTable();
    const rows = ready ? await listVerified() : [];

    return (
        <div className="space-y-6 pb-12">
            <div>
                <Link href="/ceo/analyst" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-sky hover:underline">
                    <ArrowLeft className="h-3.5 w-3.5" /> AI Analyst
                </Link>
                <h1 className="mt-2 text-2xl font-bold tracking-tight text-brand-navy">Verified queries</h1>
                <p className="mt-1 max-w-3xl text-sm text-ink-muted">
                    Queries checked and marked good from an answer (the shield button under it). A new question that is close
                    to one of these is answered from its SQL, and the answer shows a Verified badge.
                </p>
            </div>

            {!ready ? (
                <p className="max-w-3xl rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                    Verified queries are not set up on this server yet. Migration E-382 has to be applied first.
                </p>
            ) : rows.length === 0 ? (
                <p className="max-w-3xl rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">
                    No query is verified yet. Open an answer you have checked and press the shield button beside it.
                </p>
            ) : (
                <div className="max-w-3xl space-y-4">
                    <p className="text-xs text-gray-500">
                        {rows.length} verified quer{rows.length === 1 ? "y" : "ies"}
                    </p>
                    {rows.map((row) => (
                        <VerifiedQueryRow key={row.id} row={row} />
                    ))}
                </div>
            )}
        </div>
    );
}
