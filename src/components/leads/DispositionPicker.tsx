"use client";

// The L1 → L2 → L3 call-disposition cascade (E-236), as one component.
//
// It existed only as inline JSX in the /leads filter bar. Two consumers need it
// now — the campaign builder's lead-state section and the inside-sales Log
// Touchpoint form — and two copies is exactly how a filter and a form start
// disagreeing about whether "Not Connected" has buckets.
//
// The rule it owns, which is a property of the VOCABULARY rather than of any
// one screen (see the header of src/lib/leads/dispositions.ts): under
// "Not Connected" the sheet gives its ten reasons no bucket at all, so the
// bucket select is HIDDEN rather than disabled — there is nothing to choose,
// not nothing currently choosable.
//
// It also owns the reset cascade: picking a level clears the narrower ones, so
// the control can never encode a combination like "Not Connected + Hot" that
// returns nothing and reads as a bug rather than a contradiction.
//
// Lives under components/leads/ rather than in either route group because it is
// consumed from both (dashboard)/leads and (dashboard)/inside-sales.

import {
    CONNECTED_DISPOSITIONS,
    CONNECT_STATUS,
    CONNECT_STATUS_LABEL,
    DISPOSITION_BUCKETS,
    NOT_CONNECTED_REASONS,
} from "@/lib/leads/dispositions";

export type DispositionValue = {
    /** L1 — "" means "any" in filter mode, "not chosen" in form mode. */
    connectStatus: string;
    /** L2 — meaningless when L1 is not_connected. */
    bucket: string;
    /** L3 — free text: values outside the sheet are filterable too. */
    disposition: string;
};

export const EMPTY_DISPOSITION_VALUE: DispositionValue = {
    connectStatus: "",
    bucket: "",
    disposition: "",
};

const SELECT_CLASS =
    "rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-gray-400 focus:outline-none";

export function DispositionPicker({
    value,
    onChange,
    mode,
    extraDispositions = [],
    disabled = false,
    idPrefix = "disposition",
    className = "",
}: {
    value: DispositionValue;
    onChange: (next: DispositionValue) => void;
    /**
     * "filter" adds the "Any …" options and the out-of-sheet group;
     * "form" is a rep recording what actually happened, so it offers only the
     * sheet and starts blank.
     */
    mode: "filter" | "form";
    /** Values seen in the data but outside the CC sheet. filter mode only. */
    extraDispositions?: string[];
    disabled?: boolean;
    idPrefix?: string;
    className?: string;
}) {
    const isFilter = mode === "filter";

    // Picking a level clears the narrower ones.
    const setConnectStatus = (connectStatus: string) =>
        onChange({ connectStatus, bucket: "", disposition: "" });
    const setBucket = (bucket: string) =>
        onChange({ ...value, bucket, disposition: "" });
    const setDisposition = (disposition: string) =>
        onChange({ ...value, disposition });

    const showBucket = value.connectStatus !== "not_connected";

    return (
        <div className={`grid grid-cols-2 gap-3 md:grid-cols-4 ${className}`}>
            <select
                id={`${idPrefix}-connect-status`}
                aria-label="Call outcome"
                disabled={disabled}
                className={`${SELECT_CLASS} w-full disabled:bg-gray-50 disabled:text-gray-400`}
                value={value.connectStatus}
                onChange={(e) => setConnectStatus(e.target.value)}
            >
                <option value="">
                    {isFilter ? "Any call outcome" : "— call outcome —"}
                </option>
                {CONNECT_STATUS.map((s) => (
                    <option key={s} value={s}>
                        {CONNECT_STATUS_LABEL[s]}
                    </option>
                ))}
            </select>

            {/* Hidden, not disabled, when the call did not connect: the sheet
                gives those reasons no bucket at all. */}
            {showBucket && (
                <select
                    id={`${idPrefix}-bucket`}
                    aria-label="Disposition bucket"
                    disabled={disabled}
                    className={`${SELECT_CLASS} w-full disabled:bg-gray-50 disabled:text-gray-400`}
                    value={value.bucket}
                    onChange={(e) => setBucket(e.target.value)}
                >
                    <option value="">{isFilter ? "Any bucket" : "— bucket —"}</option>
                    {DISPOSITION_BUCKETS.map((b) => (
                        <option key={b} value={b}>
                            {b}
                        </option>
                    ))}
                </select>
            )}

            <select
                id={`${idPrefix}-disposition`}
                aria-label="Disposition"
                disabled={disabled}
                className={`${SELECT_CLASS} col-span-2 w-full disabled:bg-gray-50 disabled:text-gray-400`}
                value={value.disposition}
                onChange={(e) => setDisposition(e.target.value)}
            >
                <option value="">
                    {isFilter ? "Any disposition" : "— what happened on the call —"}
                </option>

                {value.connectStatus !== "not_connected" &&
                    DISPOSITION_BUCKETS.filter(
                        (b) => !value.bucket || value.bucket === b,
                    ).map((b) => (
                        <optgroup key={b} label={`Connected › ${b}`}>
                            {CONNECTED_DISPOSITIONS[b].map((d) => (
                                <option key={`${b}:${d}`} value={d}>
                                    {d}
                                </option>
                            ))}
                        </optgroup>
                    ))}

                {/* A bucket is a CONNECTED concept, so once one is picked the
                    not-connected reasons cannot apply. */}
                {value.connectStatus !== "connected" && !value.bucket && (
                    <optgroup label="Not connected">
                        {NOT_CONNECTED_REASONS.map((d) => (
                            <option key={d} value={d}>
                                {d}
                            </option>
                        ))}
                    </optgroup>
                )}

                {isFilter && extraDispositions.length > 0 && !value.bucket && (
                    <optgroup label="Other (seen in NeoDove)">
                        {extraDispositions.map((d) => (
                            <option key={d} value={d}>
                                {d}
                            </option>
                        ))}
                    </optgroup>
                )}
            </select>
        </div>
    );
}
