"use client";

// Tracker ID 197 (PJP phase 1) — the Day evidence of a Travel / Vehicle/Fuel
// claim, opened from CEO > Expenses > Travel proof. One block per claimed day:
// the verdict and note from submit, then each visit that day (verified or
// not) with its stamped photo, distance from the shop when known and in or
// outside territory; first / last visit, cities and calls are context only.
// GET /api/expenses/[id]/travel-proof answers only the CEO and the submitter.

import { useQuery } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { onFreshFileClick } from "@/lib/storage/freshFileLink";
import { VERDICT_LABEL, type DayVerdict } from "@/lib/expenses/travelProof";

type Visit = {
    visit_id: string;
    at: string;
    verified: boolean;
    kind: "existing_counter" | "existing_lead" | "new_lead";
    name: string | null;
    city: string | null;
    planned: boolean;
    outcome: string | null;
    photo_url: string | null;
    accuracy_m: number | null;
    distance_m: number | null;
    territory: "in" | "outside" | "territory_not_set" | "no_location";
};

type Day = {
    day: string;
    verdict: DayVerdict;
    visits: Visit[];
    first_visit_at: string | null;
    last_visit_at: string | null;
    cities: string[];
    calls: number;
    claimed: { verdict: DayVerdict; note: string | null };
};

const KIND: Record<Visit["kind"], string> = {
    existing_counter: "Existing counter",
    existing_lead: "Existing lead",
    new_lead: "New lead",
};

const TERRITORY: Record<Visit["territory"], string> = {
    in: "In territory",
    outside: "Outside territory",
    territory_not_set: "Territory not set",
    no_location: "No location on the lead",
};

const time = (ts: string | null) =>
    ts ? new Date(ts).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) : "—";

const pretty = (s: string | null) => (s ? s.replaceAll("_", " ") : "");

export function TravelProofPanel({ expenseId, onClose }: { expenseId: string; onClose: () => void }) {
    const { data, isLoading, error } = useQuery({
        queryKey: ["travel-proof", expenseId],
        queryFn: async () => {
            const r = await fetch(`/api/expenses/${encodeURIComponent(expenseId)}/travel-proof`, { cache: "no-store" });
            const j = await r.json();
            if (!r.ok || !j.success) throw new Error(j?.error?.message ?? "Could not load the travel proof");
            return j.data as { claim: { category: string; amount: string; submitter_name: string | null }; days: Day[] };
        },
    });

    return (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
            <div
                className="h-full w-full max-w-2xl overflow-y-auto bg-white p-5 shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="mb-4 flex items-start justify-between gap-2">
                    <div>
                        <h2 className="text-lg font-semibold text-gray-900">Travel proof — Day evidence</h2>
                        {data && (
                            <p className="text-xs text-gray-500">
                                {data.claim.submitter_name ?? "—"} · {data.claim.category} · ₹
                                {Number(data.claim.amount).toLocaleString("en-IN")}
                            </p>
                        )}
                    </div>
                    <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700" aria-label="Close">
                        <X className="h-5 w-5" />
                    </button>
                </div>
                {isLoading && <Loader2 className="mx-auto h-5 w-5 animate-spin text-gray-400" />}
                {error && <p className="text-sm text-rose-700">{(error as Error).message}</p>}
                {data?.days.map((d) => (
                    <section key={d.day} className="mb-4 rounded-xl border border-gray-200 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-semibold text-gray-900">{d.day}</h3>
                            <span
                                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                                    d.verdict === "supported" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                                }`}
                            >
                                {VERDICT_LABEL[d.verdict]}
                            </span>
                            {d.claimed.verdict !== d.verdict && (
                                <span className="text-[11px] text-gray-500">
                                    (was {VERDICT_LABEL[d.claimed.verdict]} when submitted)
                                </span>
                            )}
                        </div>
                        {d.claimed.note && (
                            <p className="mt-1 rounded bg-gray-50 px-2 py-1 text-xs text-gray-700">Note: {d.claimed.note}</p>
                        )}
                        <p className="mt-2 text-xs text-gray-500">
                            First visit {time(d.first_visit_at)} · last {time(d.last_visit_at)} · cities{" "}
                            {d.cities.join(", ") || "—"} · {d.calls} calls that day (context only)
                        </p>
                        {d.visits.length === 0 ? (
                            <p className="mt-2 text-sm text-gray-500">No visits logged that day.</p>
                        ) : (
                            <ul className="mt-2 divide-y divide-gray-100">
                                {d.visits.map((v) => (
                                    <li key={v.visit_id} className="py-2 text-sm">
                                        <div className="flex flex-wrap items-center gap-x-2">
                                            <span className="text-gray-500">{time(v.at)}</span>
                                            <span className="font-medium text-gray-900">{v.name ?? "—"}</span>
                                            <span className="text-gray-500">{v.city ?? ""}</span>
                                            <span className="text-xs text-gray-500">· {KIND[v.kind]}</span>
                                            <span className="text-xs text-gray-500">· {v.planned ? "Planned" : "Unplanned"}</span>
                                        </div>
                                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
                                            <span className={v.verified ? "text-emerald-700" : "text-amber-700"}>
                                                {v.verified
                                                    ? `Verified · GPS ±${Math.round(v.accuracy_m ?? 0)} m + photo`
                                                    : "Not verified"}
                                            </span>
                                            {v.outcome && <span className="text-gray-600">· {pretty(v.outcome)}</span>}
                                            {v.distance_m != null && (
                                                <span className="text-gray-600">
                                                    · {v.distance_m < 1000 ? `${v.distance_m} m` : `${(v.distance_m / 1000).toFixed(1)} km`} from the shop
                                                </span>
                                            )}
                                            <span className={v.territory === "outside" ? "text-rose-700" : "text-gray-600"}>
                                                · {TERRITORY[v.territory]}
                                            </span>
                                            {v.photo_url && (
                                                <a
                                                    href={v.photo_url}
                                                    onClick={(e) => onFreshFileClick(e, v.photo_url)}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="font-semibold text-brand-600 hover:underline"
                                                >
                                                    Photo
                                                </a>
                                            )}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                ))}
            </div>
        </div>
    );
}
