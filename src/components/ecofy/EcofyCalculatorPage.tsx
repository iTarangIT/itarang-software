"use client";

// E-307 — the standalone calculator screen shared by Sales Head, ASM and ISR.
// Reads its defaults from the query string so a lead's Assessment tab can
// open it prefilled (?segment=&productInterest=&monthlyUnits=&sanctionedLoadKw=).
// Opened from a lead (?leadId=&caseNo=&back=) it also offers "Save to this
// lead's assessment" (a CALCULATOR assessment, FR-07.2); the segment is then
// locked to the lead's, and the actions route re-checks access and segment.

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CalculatorAssessmentSave } from "./CalculatorAssessmentSave";
import { EcofyCalculator, type CalcSegment, type CalculatorComputed } from "./EcofyCalculator";

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

/** Same-origin path only, so a crafted link cannot send the user elsewhere. */
function safeBack(v: string | null): string | null {
    return v && v.startsWith("/") && !v.startsWith("//") && !v.includes("\\") ? v : null;
}

function Inner({ backHref }: { backHref?: { href: string; label: string } }) {
    const sp = useSearchParams();
    const leadId = sp.get("leadId");
    const caseNo = sp.get("caseNo");
    const leadBack = safeBack(sp.get("back"));
    const [computed, setComputed] = useState<CalculatorComputed | null>(null);
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
                {leadId && leadBack ? (
                    <Link href={leadBack} className="text-sm text-blue-700 hover:underline">
                        ← Back to {caseNo ?? "the lead"}
                    </Link>
                ) : (
                    backHref && (
                        <Link href={backHref.href} className="text-sm text-blue-700 hover:underline">
                            ← {backHref.label}
                        </Link>
                    )
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
                        {SEGMENTS.filter((s) => !leadId || s.code === segment).map((s) => (
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
                    <EcofyCalculator segment={segment} defaults={defaults} onComputed={leadId ? setComputed : undefined} />
                </div>
                {leadId && segment !== "CI" && (
                    <div className="border-t border-gray-100 p-4">
                        <p className="mb-2 text-sm text-gray-700">
                            Sizing for lead <b>{caseNo ?? leadId.slice(0, 8)}</b> — save this run as the lead&apos;s assessment
                            (Ecofy stores the release, the inputs and every step).
                        </p>
                        <CalculatorAssessmentSave leadId={leadId} computed={computed} label="Save to this lead's assessment" />
                    </div>
                )}
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
