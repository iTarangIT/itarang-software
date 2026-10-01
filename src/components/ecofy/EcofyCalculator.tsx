"use client";

// E-307 — the Ecofy energy calculator, rendered in the CRM.
//
// A port of Ecofy's Calculator.tsx (FR-07.1 … FR-07.7): appliance list / bill /
// running-load inputs, backup hours + phase always asked, three outcomes,
// price ranges only, no EMI. Every number comes from Ecofy's published release
// via /api/ecofy/calculator; a quick estimate is never stored (FR-07.1). With
// `onComputed`, the parent gets each input + Ecofy result pair so it can save a
// CALCULATOR assessment on a lead (FR-07.2) — the lead's Assessment tab and
// the standalone page opened from a lead.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ecofyGet, ecofyPost } from "./client";
import { ErrorNote, Field, inputCls } from "./ui";

export type CalcSegment = "RESI" | "ESS" | "CI";
type Method = "APPLIANCES" | "MONTHLY_UNITS" | "RUNNING_LOAD" | "NONE";
type Line = { applianceName: string; watts: number; quantity: number };

type Release = {
    id: string;
    version: number;
    appliances: Array<{ name: string; defaultWatts: number; isMotor: boolean }>;
    segments: Record<string, { enabled: boolean; inputs?: string[] }>;
};

export type CalcResultView = {
    releaseVersion: number;
    recommendationStatus: string;
    steps: Record<string, number | null>;
    options: Array<{
        systemCode: string;
        systemName: string;
        role: string;
        systemType: string;
        phase: string;
        usableCapacityKwh: number;
        inverterKva: number;
        solarKwp: number;
        priceRange: {
            equipmentMin: number;
            equipmentMax: number;
            installationMin: number;
            installationMax: number;
            gstPct: number;
            totalMin: number;
            totalMax: number;
        };
    }>;
    texts: { disclaimer: string; financingLine: string; message: string | null };
    pending: string[];
};

/** The CalcInput the calculator last sent and the result Ecofy computed for exactly that input. */
export interface CalculatorComputed {
    input: {
        segment: CalcSegment;
        productInterest?: string;
        method: Method;
        appliances?: Line[];
        monthlyUnits?: number;
        runningLoadKw?: number;
        sanctionedLoadKw?: number;
        backupHours?: number;
        phase: string;
    };
    result: CalcResultView;
}

export interface CalculatorDefaults {
    productInterest?: string;
    monthlyUnits?: number;
    sanctionedLoadKw?: number;
}

const inr = (v: number) => `₹${v.toLocaleString("en-IN")}`;
const STEP_LABEL: Record<string, string> = {
    running_load_kw: "Running load (kW)",
    backup_energy_kwh: "Backup energy (kWh)",
    usable_battery_needed_kwh: "Usable battery needed (kWh)",
    battery_size_kwh: "Battery size shown (kWh)",
    motor_start_kw: "Motor starting power (kW)",
    required_inverter_kva: "Inverter size (kVA)",
    solar_kwp: "Solar size (kWp)",
};
const METHOD_LABEL: Record<string, string> = {
    APPLIANCES: "Appliance list",
    MONTHLY_UNITS: "Monthly units (bill)",
    RUNNING_LOAD: "Running load",
};
const PRODUCT_INTERESTS = ["SOLAR_STORAGE", "STORAGE_ONLY", "SOLAR_ONLY", "NOT_SURE"];

const btn = (on: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium ${
        on ? "bg-gray-900 text-white" : "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50"
    }`;

/** A release bundle as the designer API returns it (params carry the segments). */
type DesignerBundle = {
    id: string;
    version: number;
    appliances: Array<{ name: string; defaultWatts: number; isMotor: boolean; active?: boolean }>;
    params?: { segments?: Record<string, { enabled: boolean; inputs?: string[] }> };
};

/**
 * `releaseId` = the designer's test bench (FR-08.4): inputs and appliances come
 * from THAT release (draft or published) and every estimate runs against it.
 * Without it, the published release is used, as on the calculator screen.
 */
export function EcofyCalculator({
    segment,
    defaults = {},
    releaseId,
    onComputed,
}: {
    segment: CalcSegment;
    defaults?: CalculatorDefaults;
    releaseId?: string;
    /** Called with the current input + its result, or null while the result is stale / missing. */
    onComputed?: (c: CalculatorComputed | null) => void;
}) {
    const rel = useQuery({
        queryKey: ["ecofy-calculator-release", releaseId ?? "published"],
        // a draft changes while it is being edited; the published release is stable
        staleTime: releaseId ? 0 : 5 * 60_000,
        queryFn: async (): Promise<Release> => {
            if (!releaseId) return ecofyGet<Release>("/api/ecofy/calculator");
            const b = await ecofyGet<DesignerBundle>(`/api/ecofy/calculator/releases/${releaseId}`);
            return {
                id: b.id,
                version: b.version,
                appliances: (b.appliances ?? [])
                    .filter((a) => a.active !== false)
                    .map((a) => ({ name: a.name, defaultWatts: a.defaultWatts, isMotor: Boolean(a.isMotor) })),
                segments: b.params?.segments ?? {},
            };
        },
    });
    const estimateUrl = releaseId ? `/api/ecofy/calculator/releases/${releaseId}/test` : "/api/ecofy/calculator";
    const appliances = useMemo(() => rel.data?.appliances ?? [], [rel.data]);
    const [method, setMethod] = useState<Method>("APPLIANCES");
    const [linesState, setLines] = useState<Line[] | null>(null);
    const [add, setAdd] = useState("");
    const [f, setF] = useState({
        productInterest: PRODUCT_INTERESTS.includes(defaults.productInterest ?? "")
            ? (defaults.productInterest as string)
            : "SOLAR_STORAGE",
        monthlyUnits: defaults.monthlyUnits != null ? String(defaults.monthlyUnits) : "",
        runningLoadKw: "",
        sanctionedLoadKw: defaults.sanctionedLoadKw != null ? String(defaults.sanctionedLoadKw) : "",
        backupHours: "4",
        phase: "SINGLE",
    });
    const [result, setResult] = useState<CalcResultView | null>(null);
    const [resultFor, setResultFor] = useState<unknown>(null);
    const [err, setErr] = useState<string | null>(null);
    const [computing, setComputing] = useState(false);

    // Until the user edits the list, show a typical household from the release's catalogue.
    const lines = useMemo<Line[]>(() => {
        if (linesState) return linesState;
        const pick = (n: string, q: number) => {
            const a = appliances.find((x) => x.name === n);
            return a ? { applianceName: a.name, watts: a.defaultWatts, quantity: q } : null;
        };
        return [pick("Ceiling fan", 4), pick("LED bulb", 6), pick("Television", 1), pick("Refrigerator", 1)].filter(
            Boolean,
        ) as Line[];
    }, [linesState, appliances]);
    const updateLines = (fn: (ls: Line[]) => Line[]) => setLines(fn(lines));

    const segCfg = rel.data?.segments?.[segment];
    const inputs = useMemo(() => segCfg?.inputs ?? ["APPLIANCES", "MONTHLY_UNITS"], [segCfg]);
    // The release decides which methods a segment offers; fall back to its first one.
    useEffect(() => {
        if (inputs.length && !inputs.includes(method)) setMethod(inputs[0] as Method);
    }, [inputs, method]);

    const input = useMemo<CalculatorComputed["input"]>(
        () => ({
            segment,
            productInterest: f.productInterest,
            method,
            appliances: method === "APPLIANCES" ? lines : undefined,
            monthlyUnits: f.monthlyUnits ? Number(f.monthlyUnits) : undefined,
            runningLoadKw: method === "RUNNING_LOAD" && f.runningLoadKw ? Number(f.runningLoadKw) : undefined,
            sanctionedLoadKw: f.sanctionedLoadKw ? Number(f.sanctionedLoadKw) : undefined,
            backupHours: f.productInterest === "SOLAR_ONLY" ? undefined : Number(f.backupHours || 0),
            phase: f.phase,
        }),
        [segment, f, method, lines],
    );

    useEffect(() => {
        if (segment === "CI" || !rel.data) return;
        let cancelled = false;
        const t = setTimeout(async () => {
            setComputing(true);
            try {
                const r = await ecofyPost<CalcResultView>(estimateUrl, input);
                if (!cancelled) {
                    setResult(r);
                    setResultFor(input);
                    setErr(null);
                }
            } catch (e) {
                if (!cancelled) setErr(e instanceof Error ? e.message : "Ecofy could not compute the estimate");
            } finally {
                if (!cancelled) setComputing(false);
            }
        }, 350);
        return () => {
            cancelled = true;
            clearTimeout(t);
        };
    }, [input, segment, rel.data, estimateUrl]);

    // Hand the parent a result only while it belongs to the inputs on screen.
    useEffect(() => {
        if (!onComputed) return;
        onComputed(result && resultFor === input && segment !== "CI" ? { input, result } : null);
    }, [onComputed, result, resultFor, input, segment]);

    if (segment === "CI") {
        return (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                C&amp;I: the calculator is off. <b>EPC quote required</b> — record a manual or EPC assessment on the
                lead.
            </p>
        );
    }
    if (rel.isLoading) return <p className="text-sm text-gray-500">Loading the calculator from Ecofy…</p>;
    if (rel.error) return <ErrorNote error={rel.error} />;
    if (segCfg && segCfg.enabled === false) {
        return (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                The calculator is switched off for this segment in Ecofy&apos;s published release.
            </p>
        );
    }

    const rec = result?.options.find((o) => o.role === "RECOMMENDED");
    const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
        setF((x) => ({ ...x, [k]: e.target.value }));

    return (
        <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
            <div className="space-y-3">
                <div className="flex flex-wrap gap-1">
                    {inputs.map((m) => (
                        <button key={m} type="button" className={btn(method === m)} onClick={() => setMethod(m as Method)}>
                            {METHOD_LABEL[m] ?? m}
                        </button>
                    ))}
                </div>

                {method === "APPLIANCES" && (
                    <div className="rounded-lg border border-gray-200">
                        <div className="grid grid-cols-[1.6fr_.8fr_.8fr_.9fr_34px] gap-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                            <span>Appliance</span>
                            <span>Watts</span>
                            <span>Qty</span>
                            <span>Load</span>
                            <span />
                        </div>
                        {lines.length === 0 && (
                            <p className="border-t border-gray-100 px-3 py-2 text-sm text-gray-500">Add at least one appliance.</p>
                        )}
                        {lines.map((l, i) => (
                            <div
                                key={i}
                                className="grid grid-cols-[1.6fr_.8fr_.8fr_.9fr_34px] items-center gap-2 border-t border-gray-100 px-3 py-1.5 text-sm"
                            >
                                <span className="text-gray-900">
                                    {l.applianceName}
                                    {appliances.find((a) => a.name === l.applianceName)?.isMotor && (
                                        <span className="ml-1 text-[10.5px] text-amber-700">motor</span>
                                    )}
                                </span>
                                <input
                                    className={inputCls}
                                    type="number"
                                    min={1}
                                    value={l.watts}
                                    onChange={(e) =>
                                        updateLines((x) => x.map((y, j) => (j === i ? { ...y, watts: Number(e.target.value) } : y)))
                                    }
                                />
                                <input
                                    className={inputCls}
                                    type="number"
                                    min={1}
                                    value={l.quantity}
                                    onChange={(e) =>
                                        updateLines((x) => x.map((y, j) => (j === i ? { ...y, quantity: Number(e.target.value) } : y)))
                                    }
                                />
                                <span className="tabular-nums text-gray-700">{l.watts * l.quantity} W</span>
                                <button
                                    type="button"
                                    aria-label="Remove"
                                    className="text-gray-400 hover:text-red-600"
                                    onClick={() => updateLines((x) => x.filter((_, j) => j !== i))}
                                >
                                    ✕
                                </button>
                            </div>
                        ))}
                        <div className="flex items-center gap-2 border-t border-gray-100 px-3 py-2">
                            <select className={inputCls} value={add} onChange={(e) => setAdd(e.target.value)}>
                                <option value="">Add appliance…</option>
                                {appliances.map((a) => (
                                    <option key={a.name} value={a.name}>
                                        {a.name} ({a.defaultWatts} W)
                                    </option>
                                ))}
                            </select>
                            <button
                                type="button"
                                className={btn(false)}
                                onClick={() => {
                                    const a = appliances.find((x) => x.name === add);
                                    if (a) {
                                        updateLines((x) => [...x, { applianceName: a.name, watts: a.defaultWatts, quantity: 1 }]);
                                        setAdd("");
                                    }
                                }}
                            >
                                + Add
                            </button>
                        </div>
                    </div>
                )}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {method === "RUNNING_LOAD" && (
                        <Field label="Running load (kW)">
                            <input
                                className={inputCls}
                                type="number"
                                step="0.1"
                                min={0}
                                value={f.runningLoadKw}
                                onChange={set("runningLoadKw")}
                            />
                        </Field>
                    )}
                    <Field
                        label="Monthly units (from bill)"
                        hint={
                            method === "MONTHLY_UNITS"
                                ? "Bill-only sizing uses the sanctioned load for power."
                                : "Needed for the solar step."
                        }
                    >
                        <input className={inputCls} type="number" min={0} value={f.monthlyUnits} onChange={set("monthlyUnits")} />
                    </Field>
                    {method === "MONTHLY_UNITS" && (
                        <Field label="Sanctioned load (kW)">
                            <input
                                className={inputCls}
                                type="number"
                                step="0.1"
                                min={0}
                                value={f.sanctionedLoadKw}
                                onChange={set("sanctionedLoadKw")}
                            />
                        </Field>
                    )}
                    <Field label="Product interest">
                        <select className={inputCls} value={f.productInterest} onChange={set("productInterest")}>
                            <option value="SOLAR_STORAGE">Solar + storage</option>
                            <option value="STORAGE_ONLY">Storage only</option>
                            <option value="SOLAR_ONLY">Solar only</option>
                            <option value="NOT_SURE">Not sure</option>
                        </select>
                    </Field>
                    {f.productInterest !== "SOLAR_ONLY" && (
                        <Field label="Backup required (hours)">
                            <input
                                className={inputCls}
                                type="number"
                                min={0}
                                max={24}
                                value={f.backupHours}
                                onChange={set("backupHours")}
                            />
                        </Field>
                    )}
                    <Field label="Phase">
                        <select className={inputCls} value={f.phase} onChange={set("phase")}>
                            <option value="SINGLE">Single</option>
                            <option value="THREE">Three</option>
                        </select>
                    </Field>
                </div>
                <p className="text-xs text-gray-500">
                    {result?.texts.disclaimer ?? "Indicative price range. The final price comes from the EPC partner's quote."}{" "}
                    Release v{result?.releaseVersion ?? rel.data?.version ?? "—"}.
                </p>
            </div>

            <div className="space-y-3">
                {err && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</p>}
                <div className="rounded-xl bg-gradient-to-br from-gray-900 to-sky-900 p-4 text-white">
                    <div className="flex items-center justify-between text-[11px] uppercase tracking-wider opacity-80">
                        <span>Recommended battery size</span>
                        {computing && <span className="normal-case tracking-normal opacity-70">updating…</span>}
                    </div>
                    <div className="text-[32px] font-bold leading-none">
                        {result?.steps.battery_size_kwh ?? "—"} <span className="text-sm font-normal">kWh</span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                        {Object.entries(STEP_LABEL)
                            .filter(([k]) => k !== "battery_size_kwh")
                            .map(([k, label]) => (
                                <div key={k} className="rounded-lg bg-white/10 px-2.5 py-1.5">
                                    <div className="opacity-75">{label}</div>
                                    <div className="text-[15px] tabular-nums">{result?.steps[k] ?? "—"}</div>
                                </div>
                            ))}
                    </div>
                </div>

                {result && result.recommendationStatus !== "RECOMMENDED" && (
                    <p
                        className={`rounded-lg p-3 text-sm ${
                            result.recommendationStatus === "PENDING_TECHNICAL_DATA"
                                ? "bg-amber-50 text-amber-900"
                                : "bg-purple-50 text-purple-900"
                        }`}
                    >
                        <b>{result.recommendationStatus.replace(/_/g, " ")}.</b> {result.texts.message}
                        {result.pending?.length ? ` (missing: ${result.pending.join(", ")})` : ""}
                    </p>
                )}

                {result && result.options.length > 0 && (
                    <div className="space-y-1.5">
                        {result.options.map((o) => {
                            const isRec = o.role === "RECOMMENDED";
                            return (
                                <div
                                    key={o.systemCode}
                                    className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
                                        isRec ? "border-sky-400 bg-sky-50" : "border-gray-200 bg-white"
                                    }`}
                                >
                                    <div className="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded bg-gray-900 text-white">
                                        <span className="text-[13px] font-bold tabular-nums">{o.usableCapacityKwh}</span>
                                        <span className="text-[9px]">kWh</span>
                                    </div>
                                    <div className="flex-1 text-[12.5px]">
                                        <div className="font-semibold text-gray-900">
                                            {o.systemName}{" "}
                                            <span
                                                className={`ml-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                                    isRec ? "bg-sky-100 text-sky-800" : "bg-gray-100 text-gray-600"
                                                }`}
                                            >
                                                {o.role}
                                            </span>
                                        </div>
                                        <div className="text-gray-500">
                                            {o.inverterKva} kVA · {o.solarKwp} kWp · {o.phase.toLowerCase()} phase ·{" "}
                                            {o.systemType.replace("_", " ").toLowerCase()}
                                        </div>
                                    </div>
                                    <div className="text-right text-xs">
                                        <div className="font-semibold tabular-nums text-gray-900">
                                            {inr(o.priceRange.totalMin)}–{inr(o.priceRange.totalMax)}
                                        </div>
                                        <div className="text-gray-500">
                                            equipment {inr(o.priceRange.equipmentMin)}–{inr(o.priceRange.equipmentMax)}
                                        </div>
                                        <div className="text-gray-500">
                                            install {inr(o.priceRange.installationMin)}–{inr(o.priceRange.installationMax)} · GST{" "}
                                            {o.priceRange.gstPct}%
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                        <p className="text-xs text-gray-500">{result.texts.financingLine} No EMI is shown.</p>
                    </div>
                )}
                {rec && (
                    <p className="text-xs text-gray-500">
                        Smallest active system for the segment, phase and type that covers the need, with one smaller and one
                        larger alternative.
                    </p>
                )}
            </div>
        </div>
    );
}
