import Link from "next/link";
import { requireRole } from "@/lib/auth-utils";
import { WHATSAPP_SCREENSHOT_LIMIT, listWhatsappScreenshots } from "@/lib/leads/whatsappContact";

export const dynamic = "force-dynamic";

// Tracker ID 79 (handover P2-7): a WhatsApp chat counts as contact only with a
// screenshot of it. This is the Sales Head's view of those screenshots — who
// logged which chat, on which lead, and whether it was counted. An image whose
// bytes were already used on another entry is REUSED: listed first, flagged,
// with the entry that used it before.
const ROLES = ["admin", "sales_head", "ceo", "business_head", "sales_manager"];
const RANGES = [7, 30, 90] as const;

function fmt(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso.replace(" ", "T"));
    return Number.isNaN(d.getTime())
        ? iso
        : d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
}

export default async function WhatsappScreenshotsPage({
    searchParams,
}: {
    searchParams: Promise<{ days?: string }>;
}) {
    await requireRole(ROLES);
    const { days: raw } = await searchParams;
    const days = (RANGES as readonly number[]).includes(Number(raw)) ? Number(raw) : 7;
    const rows = await listWhatsappScreenshots(days);
    const reused = rows.filter((r) => r.reused).length;
    const counted = rows.filter((r) => r.counted).length;

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <header className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-ink">WhatsApp Screenshots</h1>
                    <p className="mt-1 text-sm text-ink-muted">
                        A WhatsApp chat counts as contact only with a screenshot. These are the screenshots reps logged —
                        from the CRM and from the WhatsApp Assistant. A reused image is flagged and is never counted.
                    </p>
                </div>
                <nav className="flex items-center gap-1 text-xs">
                    {RANGES.map((d) => (
                        <Link
                            key={d}
                            href={`/admin/whatsapp-screenshots?days=${d}`}
                            className={`rounded-md border px-2.5 py-1 font-medium ${
                                d === days
                                    ? "border-gray-900 bg-gray-900 text-white"
                                    : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                            }`}
                        >
                            Last {d} days
                        </Link>
                    ))}
                </nav>
            </header>

            {rows.length === 0 ? (
                <p className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">
                    No WhatsApp screenshots in the last {days} days.
                </p>
            ) : (
                <>
                    <p className="text-sm text-gray-600">
                        <span className="font-semibold text-gray-900">{rows.length}</span> screenshot{rows.length === 1 ? "" : "s"}
                        {" · "}
                        <span className="font-semibold text-emerald-700">{counted}</span> counted as contact
                        {" · "}
                        <span className={reused > 0 ? "font-semibold text-rose-700" : "font-semibold text-gray-900"}>{reused}</span>{" "}
                        reused
                        {rows.length >= WHATSAPP_SCREENSHOT_LIMIT && (
                            <span className="ml-2 text-amber-700">
                                Showing the first {WHATSAPP_SCREENSHOT_LIMIT} — pick a shorter range to see the rest.
                            </span>
                        )}
                    </p>
                    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {rows.map((r) => (
                            <li
                                key={r.touchpoint_id}
                                className={`flex gap-3 rounded-lg border bg-white p-3 ${
                                    r.reused ? "border-rose-300" : "border-gray-200"
                                }`}
                            >
                                {r.url ? (
                                    <a href={r.url} target="_blank" rel="noreferrer" className="shrink-0">
                                        {/* The stored file through the CRM's own (auth'd) files route. */}
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img
                                            src={r.url}
                                            alt="WhatsApp chat screenshot"
                                            className={`h-28 w-20 rounded-md border object-cover ${
                                                r.reused ? "border-rose-400" : "border-gray-200"
                                            }`}
                                        />
                                    </a>
                                ) : (
                                    <div className="flex h-28 w-20 shrink-0 items-center justify-center rounded-md border border-dashed border-gray-200 text-[10px] text-gray-400">
                                        no image
                                    </div>
                                )}
                                <div className="min-w-0 flex-1 text-xs">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                        <Link
                                            href={`/leads/${encodeURIComponent(r.dealer_lead_id)}`}
                                            className="truncate text-sm font-medium text-blue-700 hover:underline"
                                        >
                                            {r.dealer_name ?? r.dealer_lead_id}
                                        </Link>
                                        {r.reused ? (
                                            <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-800">
                                                REUSED
                                            </span>
                                        ) : r.counted ? (
                                            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                                                Counted
                                            </span>
                                        ) : (
                                            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-600">
                                                Note only
                                            </span>
                                        )}
                                    </div>
                                    <p className="mt-0.5 text-gray-500">
                                        {r.city ? `${r.city} · ` : ""}
                                        {r.performed_by_name ?? "Unknown"} · {fmt(r.performed_at)}
                                    </p>
                                    {r.remarks && <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-gray-700">{r.remarks}</p>}
                                    {r.reused && (
                                        <p className="mt-1.5 rounded bg-rose-50 px-2 py-1 text-rose-800">
                                            {r.first_used_at
                                                ? `Same image first used by ${r.first_used_by_name ?? "someone"} on ${
                                                      r.first_used_dealer_name ?? "another lead"
                                                  }, ${fmt(r.first_used_at)}.`
                                                : "The same image was already used on another entry."}
                                        </p>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </div>
    );
}
