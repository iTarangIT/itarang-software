import Link from "next/link";
import { MapPin } from "lucide-react";

import { bookedDealerVisits } from "@/lib/visits/dealerVisitStore";
import { overdueDays } from "@/lib/asm/nextBooking";
import { istDay } from "@/lib/visits/verifiedCapture";

/**
 * ID 241-2 — My visits: the next visits booked on existing dealers (My dealers >
 * Log visit > Next visit date), the viewer's own and, for a manager, the team's.
 * Overdue ones first (oldest date first). Shows nothing when there are none, so
 * My visits looks exactly as before for anyone without a dealer booking.
 */
export async function DealerVisitsBooked({ viewerId, teamIds }: { viewerId: string; teamIds: readonly string[] }) {
    const rows = await bookedDealerVisits([viewerId, ...teamIds]);
    if (rows.length === 0) return null;
    const today = istDay(new Date());
    const fmt = (d: string) =>
        new Date(`${d}T00:00:00+05:30`).toLocaleDateString("en-IN", {
            weekday: "short",
            day: "numeric",
            month: "short",
            timeZone: "Asia/Kolkata",
        });
    return (
        <section className="rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
            <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-gray-900">Dealer visits booked · {rows.length}</h2>
                <Link href="/my-dealers" className="text-xs font-medium text-brand-sky hover:underline">
                    My dealers
                </Link>
            </div>
            <ul className="mt-2 divide-y divide-gray-100">
                {rows.map((r) => {
                    const late = overdueDays(r.scheduled_date, today);
                    const due = r.scheduled_date === today;
                    return (
                        <li key={r.visit_id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                            <div className="min-w-0">
                                <Link href={`/my-dealers/${encodeURIComponent(r.account_id)}`} className="font-medium text-brand-sky hover:underline">
                                    {r.dealer}
                                </Link>
                                <span className="text-gray-500">
                                    {r.city ? ` · ${r.city}` : ""}
                                    {r.asm_id !== viewerId && r.asm_name ? ` · ${r.asm_name}` : ""}
                                </span>
                            </div>
                            <div className="flex items-center gap-3">
                                <span className={late ? "font-medium text-rose-600" : due ? "font-medium text-amber-700" : "text-gray-700"}>
                                    {fmt(r.scheduled_date)}
                                    {late ? ` · ${late} day${late === 1 ? "" : "s"} overdue` : due ? " · today" : ""}
                                </span>
                                <Link
                                    href={`/visits/capture?account=${encodeURIComponent(r.account_id)}`}
                                    className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-medium text-brand-sky hover:bg-gray-50"
                                >
                                    <MapPin className="h-3.5 w-3.5" /> Log visit
                                </Link>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
