import { sql } from "drizzle-orm";

import { requireRole } from "@/lib/auth-utils";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type Row = {
    opened_at: string;
    lead_id: string | null;
    object_key: string;
    user_name: string | null;
    user_email: string | null;
    role: string | null;
    via: string;
    allowed: boolean;
};

const LIMIT = 500;

const rowsOf = <T,>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

// ID 166 point 4 — who opened which customer KYC file, and when. Every open is
// written by /api/files (E-339 file_access_log), refused ones included. Admin
// reads it; the CEO sees the same page.
export default async function FileAccessLogPage({
    searchParams,
}: {
    searchParams: Promise<{ lead?: string; refused?: string }>;
}) {
    await requireRole(["admin", "ceo"]);
    const sp = await searchParams;
    const lead = (sp.lead ?? "").trim().slice(0, 64);
    const refusedOnly = sp.refused === "1";

    const present = !!rowsOf<{ present: boolean }>(
        await db.execute(sql`SELECT to_regclass('public.file_access_log') IS NOT NULL AS present`),
    )[0]?.present;

    const rows: Row[] = present
        ? rowsOf<Row>(
              await db.execute(sql`
                  SELECT f.opened_at, f.lead_id, f.object_key, u.name AS user_name, u.email AS user_email,
                         f.role, f.via, f.allowed
                    FROM file_access_log f
                    LEFT JOIN users u ON u.id = f.user_id
                   WHERE TRUE
                     ${lead ? sql`AND f.lead_id = ${lead}` : sql``}
                     ${refusedOnly ? sql`AND NOT f.allowed` : sql``}
                   ORDER BY f.opened_at DESC
                   LIMIT ${LIMIT}
              `),
          )
        : [];

    const fmt = new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    });

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1100px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">KYC file opens</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Every time someone opens a customer&apos;s KYC file (Aadhaar, PAN, photos, consent): who, which file and
                    when. Refused attempts are listed too. Latest {LIMIT} shown.
                </p>
            </header>

            <form className="flex flex-wrap items-center gap-3 text-sm" method="get">
                <label className="flex items-center gap-2 text-ink-muted">
                    Lead
                    <input
                        name="lead"
                        defaultValue={lead}
                        placeholder="LEAD-…"
                        className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-ink"
                    />
                </label>
                <label className="flex items-center gap-2 text-ink-muted">
                    <input type="checkbox" name="refused" value="1" defaultChecked={refusedOnly} />
                    Refused only
                </label>
                <button type="submit" className="rounded-lg border border-border bg-surface px-3 py-1.5 text-ink">
                    Show
                </button>
            </form>

            {!present ? (
                <p className="rounded-xl border border-border bg-surface p-4 text-sm text-ink-muted">
                    The log table is not on this database yet (migration E-339). Opens are not being recorded.
                </p>
            ) : rows.length === 0 ? (
                <p className="rounded-xl border border-border bg-surface p-4 text-sm text-ink-muted">No file opens recorded.</p>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-border bg-surface">
                    <table className="w-full text-sm">
                        <thead className="text-left text-ink-muted">
                            <tr className="border-b border-border">
                                <th className="px-3 py-2 font-medium">When</th>
                                <th className="px-3 py-2 font-medium">Who</th>
                                <th className="px-3 py-2 font-medium">Lead</th>
                                <th className="px-3 py-2 font-medium">File</th>
                                <th className="px-3 py-2 font-medium">How</th>
                                <th className="px-3 py-2 font-medium">Result</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((r, i) => (
                                <tr key={i} className="border-b border-border last:border-0">
                                    <td className="px-3 py-2 whitespace-nowrap">{fmt.format(new Date(r.opened_at))}</td>
                                    <td className="px-3 py-2">
                                        {r.via === "signed_link"
                                            ? "Shared link (no login)"
                                            : `${r.user_name ?? r.user_email ?? "Unknown user"}${r.role ? ` · ${r.role}` : ""}`}
                                    </td>
                                    <td className="px-3 py-2 whitespace-nowrap">
                                        {r.lead_id ? <a className="underline" href={`?lead=${encodeURIComponent(r.lead_id)}`}>{r.lead_id}</a> : "—"}
                                    </td>
                                    <td className="px-3 py-2 break-all">{r.object_key.split("/").pop()}</td>
                                    <td className="px-3 py-2">{r.via === "signed_link" ? "Link" : "Login"}</td>
                                    <td className={`px-3 py-2 ${r.allowed ? "" : "text-red-600 font-medium"}`}>
                                        {r.allowed ? "Opened" : "Refused"}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
