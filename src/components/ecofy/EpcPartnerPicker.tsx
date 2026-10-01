"use client";

// E-307 — pick an EPC partner ("EPC agent"), or add a new one on the spot.
//
// Used wherever a lead form needs an EPC partner: EPC site visit booking,
// quote request, quote upload and installation. Sales Head, ASM and ISR can
// all add one; the new partner is selected as soon as Ecofy has stored it.

import { useState } from "react";
import { pincodesInAddress, type EpcPartnerInput } from "@/lib/ecofy/actionSchemas";
import { useCreateEpcPartner, useLookup, type EpcPartner } from "./client";
import { Btn, Field, inputCls } from "./ui";

type Draft = { name: string; phone: string; address: string; shopName: string };
const EMPTY: Draft = { name: "", phone: "", address: "", shopName: "" };

function toInput(d: Draft): EpcPartnerInput {
    return {
        name: d.name.trim(),
        phone: d.phone.replace(/\D/g, "").replace(/^91(?=\d{10}$)/, ""),
        address: d.address.trim(),
        shopName: d.shopName.trim() || undefined,
    };
}

/** The "new EPC agent" form on its own — the picker and the EPC agents page both use it. */
export function EpcPartnerForm({
    onCreated,
    onCancel,
    compact,
}: {
    onCreated: (p: EpcPartner) => void;
    onCancel?: () => void;
    compact?: boolean;
}) {
    const create = useCreateEpcPartner();
    const [d, setD] = useState<Draft>(EMPTY);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const set = (k: keyof Draft, v: string) => setD((x) => ({ ...x, [k]: v }));
    const input = toInput(d);
    const pincodes = pincodesInAddress(input.address);
    const valid = input.name.length >= 2 && /^[6-9][0-9]{9}$/.test(input.phone) && input.address.length >= 6 && pincodes.length > 0;

    async function save() {
        if (!valid || busy) return;
        setBusy(true);
        setError(null);
        try {
            const created = await create(input);
            setD(EMPTY);
            onCreated(created);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not add the EPC agent");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="grid grid-cols-1 gap-3 rounded-lg border border-violet-200 bg-violet-50/60 p-3 sm:grid-cols-2" role="group" aria-label="New EPC agent">
            <Field label="Name">
                <input className={inputCls} value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="Agent's name" autoFocus={compact} />
            </Field>
            <Field label="Phone" hint="10 digits, no +91">
                <input className={inputCls} inputMode="numeric" value={d.phone} onChange={(e) => set("phone", e.target.value)} />
            </Field>
            <Field
                label="Address"
                wide
                hint={
                    input.address && pincodes.length === 0
                        ? "Include the 6-digit pincode — Ecofy files the agent by pincode."
                        : pincodes.length
                          ? `Serves pincode ${pincodes.join(", ")}`
                          : "With pincode, e.g. Shop 4, MG Road, Nashik 422001"
                }
            >
                <input className={inputCls} value={d.address} onChange={(e) => set("address", e.target.value)} />
            </Field>
            <Field label="Shop name (optional)" wide>
                <input className={inputCls} value={d.shopName} onChange={(e) => set("shopName", e.target.value)} />
            </Field>
            {error && <p className="text-xs text-red-600 sm:col-span-2">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2 sm:col-span-2">
                {onCancel && (
                    <Btn disabled={busy} onClick={onCancel}>
                        Cancel
                    </Btn>
                )}
                <Btn variant="primary" disabled={busy || !valid} onClick={save}>
                    {busy ? "Saving…" : "Save EPC agent"}
                </Btn>
            </div>
        </div>
    );
}

/**
 * Select + "New" toggle. `value` is the partner id ("" = none). Inactive
 * partners are hidden unless one is the current value. Renders as Field(s)
 * inside the caller's 2-column grid; the inline form spans both columns.
 */
export function EpcPartnerPicker({
    value,
    onChange,
    label = "EPC agent",
    placeholder = "—",
    required,
    wide,
}: {
    value: string;
    onChange: (id: string) => void;
    label?: string;
    placeholder?: string;
    required?: boolean;
    wide?: boolean;
}) {
    const epcs = useLookup<EpcPartner>("epc-partners");
    const [adding, setAdding] = useState(false);
    const options = (epcs.data ?? []).filter((e) => e.active || e.id === value);

    return (
        <>
            <Field label={label} wide={wide}>
                <div className="flex gap-2">
                    <select required={required} className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
                        <option value="">{epcs.isLoading ? "Loading…" : placeholder}</option>
                        {options.map((e) => (
                            <option key={e.id} value={e.id}>
                                {e.name}
                                {e.active ? "" : " (inactive)"}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        onClick={() => setAdding((a) => !a)}
                        className="shrink-0 rounded-md border border-violet-300 bg-white px-2.5 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-50"
                        title="Add a new EPC agent"
                    >
                        {adding ? "Close" : "+ New"}
                    </button>
                </div>
                {epcs.error ? (
                    <span className="font-normal text-red-600">{epcs.error instanceof Error ? epcs.error.message : "Could not load EPC agents"}</span>
                ) : null}
            </Field>
            {adding && (
                <div className="sm:col-span-2">
                    <EpcPartnerForm
                        compact
                        onCancel={() => setAdding(false)}
                        onCreated={(p) => {
                            onChange(p.id);
                            setAdding(false);
                        }}
                    />
                </div>
            )}
        </>
    );
}
