"use client";

// E-307 — the standalone calculator screen shared by Sales Head, ASM and ISR.
// Reads its defaults from the query string so a lead's Assessment tab can
// open it prefilled (?segment=&productInterest=&monthlyUnits=&sanctionedLoadKw=).

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { EcofyCalculator, type CalcSegment } from "./EcofyCalculator";

const SEGMENTS: Array<{ code: CalcSegment; label: string }> = [
    { code: "RESI", label: "Residential" },
    { code: "ESS", label: "ESS" },
    { code: "CI", label: "C&I" },
];

function numParam(v: string | null): number | undefined {
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function Inner({ backHref }: { backHref?: { href: string; label: string } }) {
    const sp = useSearchParams();
    const initial = (sp.get("segment") ?? "RESI").toUpperCase();
    const [segment, setSegment] = useState<CalcSegment>(
        SEGMENTS.some((s) => s.code === initial) ? (initial as CalcSegment) : "RESI",
    );
    const defaults = {
        productInterest: sp.get("productInterest") ?? undefined,
        monthlyUnits: numParam(sp.get("monthlyUnits")),
        sanctionedLoadKw: numParam(sp.get("sanctionedLoadKw")),
    };

    return (
        <div className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 md:px-8">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Ecofy — Calculator</h1>
                    <p className="mt-1 text-sm text-gray-600">
                        Size a solar / storage system the way Ecofy does, on Ecofy&apos;s published release. Quick estimates are
                        never stored — to attach a sizing to a lead, open the lead&apos;s Assessment tab.
                    </p>
                </div>
                {backHref && (
                    <Link href={backHref.href} className="text-sm text-blue-700 hover:underline">
                        ← {backHref.label}
                    </Link>
                )}
            </header>

            <p className="rounded-lg border border-sky-100 bg-sky-50 p-3 text-sm text-sky-900">
                Standard-system prices are indicative ranges (equipment, installation and GST shown separately); the final
                price is always the EPC partner&apos;s quote. No EMI is calculated.
            </p>

            <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
                    <h2 className="text-sm font-semibold text-gray-900">Energy calculator</h2>
                    <div className="flex gap-1">
                        {SEGMENTS.map((s) => (
                            <button
                                key={s.code}
                                type="button"
                                className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                                    segment === s.code
                                        ? "bg-gray-900 text-white"
                                        : "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50"
                                }`}
                                onClick={() => setSegment(s.code)}
                            >
                                {s.label}
                            </button>
                        ))}
                    </div>
                </header>
                <div className="p-4">
                    <EcofyCalculator segment={segment} defaults={defaults} />
                </div>
            </section>
        </div>
    );
}

export function EcofyCalculatorPage(p: { backHref?: { href: string; label: string } }) {
    return (
        <Suspense fallback={<p className="p-6 text-sm text-gray-500">Loading…</p>}>
            <Inner backHref={p.backHref} />
        </Suspense>
    );
}
