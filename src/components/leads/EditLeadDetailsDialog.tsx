"use client";

// 24 Nov (CRM item 2): edit a lead's dealer details from the lead page —
// name, shop, city, state, area, pincode, type of business + segments
// (the 24 Nov tree, BusinessTypeSegmentPicker), language. Saves
// through PATCH /api/dealer-leads/[id] (owner / assigned ASM / managers;
// the server checks the same rule as canEditLead).

import { useState } from "react";
import { Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { isBusinessType, type BusinessType } from "@/lib/leads/businessType";
import { storedSegments } from "@/lib/leads/segments";
import { BusinessTypeSegmentPicker, typeSegmentProblem } from "@/components/leads/BusinessTypeSegmentPicker";

export type EditableLeadDetails = {
    id: string;
    dealer_name: string | null;
    shop_name: string | null;
    city: string | null;
    state: string | null;
    area: string | null;
    pincode: string | null;
    language: string | null;
    business_type?: string | null;
    segments?: string[] | null;
};

type Form = {
    dealer_name: string;
    shop_name: string;
    city: string;
    state: string;
    area: string;
    pincode: string;
    language: string;
    business_type: BusinessType | "";
    segments: string[];
};

const PINCODE_RE = /^\d{6}$/;

/** Field-level problems; empty when the form can be saved. Exported for tests. */
export function validateLeadDetails(f: Form): Partial<Record<keyof Form, string>> {
    const e: Partial<Record<keyof Form, string>> = {};
    if (!f.dealer_name.trim()) e.dealer_name = "Dealer name is required";
    if (f.pincode.trim() && !PINCODE_RE.test(f.pincode.trim())) e.pincode = "Pincode is 6 digits";
    const problem = typeSegmentProblem(f.business_type, f.segments);
    if (problem && !f.business_type) e.business_type = problem;
    else if (problem) e.segments = problem;
    return e;
}

export function EditLeadDetailsButton({
    lead,
    onSaved,
    label = "Edit details",
}: {
    lead: EditableLeadDetails;
    onSaved?: () => void;
    label?: string;
}) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-gray-50"
            >
                <Pencil className="h-3 w-3" />
                {label}
            </button>
            {open && (
                <EditLeadDetailsDialog
                    lead={lead}
                    onClose={() => setOpen(false)}
                    onSaved={() => {
                        setOpen(false);
                        onSaved?.();
                    }}
                />
            )}
        </>
    );
}

function EditLeadDetailsDialog({
    lead,
    onClose,
    onSaved,
}: {
    lead: EditableLeadDetails;
    onClose: () => void;
    onSaved: () => void;
}) {
    const [form, setForm] = useState<Form>({
        dealer_name: lead.dealer_name ?? "",
        shop_name: lead.shop_name ?? "",
        city: lead.city ?? "",
        state: lead.state ?? "",
        area: lead.area ?? "",
        pincode: lead.pincode ?? "",
        language: lead.language ?? "",
        business_type: isBusinessType(lead.business_type) ? lead.business_type : "",
        segments: storedSegments(lead.segments),
    });
    const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
    const [saving, setSaving] = useState(false);

    const set = (k: Exclude<keyof Form, "business_type" | "segments">) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

    async function save() {
        const e = validateLeadDetails(form);
        setErrors(e);
        if (Object.keys(e).length) return;
        setSaving(true);
        try {
            const res = await fetch(`/api/dealer-leads/${encodeURIComponent(lead.id)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    dealer_name: form.dealer_name.trim(),
                    shop_name: form.shop_name.trim(),
                    city: form.city.trim(),
                    state: form.state.trim(),
                    area: form.area.trim(),
                    pincode: form.pincode.trim(),
                    language: form.language.trim(),
                    business_type: form.business_type,
                    segments: form.segments,
                }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok || !json?.success) {
                throw new Error(json?.error?.message ?? "Could not save the details");
            }
            if (json.business_type_saved === false) {
                toast.warning("Details saved, but the type of business could not be saved on this server.");
            } else {
                toast.success("Lead details saved.");
            }
            onSaved();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl">
                <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
                    <h2 className="text-base font-semibold text-gray-900">Edit lead details</h2>
                    <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
                        <X className="h-4 w-4" />
                    </button>
                </div>
                <div className="grid grid-cols-2 gap-3 px-6 py-5">
                    <Input label="Dealer name *" value={form.dealer_name} onChange={set("dealer_name")} error={errors.dealer_name} />
                    <Input label="Shop name" value={form.shop_name} onChange={set("shop_name")} />
                    <div className="col-span-2">
                        <BusinessTypeSegmentPicker
                            type={form.business_type}
                            segments={form.segments}
                            onType={(t) => setForm((f) => ({ ...f, business_type: t }))}
                            onSegments={(segs) => setForm((f) => ({ ...f, segments: segs }))}
                            typeError={errors.business_type}
                            segmentError={errors.segments}
                        />
                    </div>
                    <Input label="City" value={form.city} onChange={set("city")} />
                    <Input label="State" value={form.state} onChange={set("state")} />
                    <Input label="Area" value={form.area} onChange={set("area")} />
                    <Input
                        label="Pincode"
                        value={form.pincode}
                        onChange={(v) => set("pincode")(v.replace(/\D/g, "").slice(0, 6))}
                        error={errors.pincode}
                        inputMode="numeric"
                    />
                    <Input label="Language" value={form.language} onChange={set("language")} />
                </div>
                <div className="flex justify-end gap-2 border-t border-gray-100 px-6 py-3">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={saving}
                        className="rounded-lg border border-gray-200 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={() => void save()}
                        disabled={saving}
                        className="rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                        {saving ? "Saving…" : "Save"}
                    </button>
                </div>
            </div>
        </div>
    );
}

function Input({
    label,
    value,
    onChange,
    error,
    inputMode,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    error?: string;
    inputMode?: "numeric";
}) {
    return (
        <div>
            <label className="block text-xs font-medium text-gray-700">{label}</label>
            <input
                value={value}
                inputMode={inputMode}
                onChange={(e) => onChange(e.target.value)}
                className={`mt-1 w-full rounded-md border px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500 ${
                    error ? "border-rose-300" : "border-gray-200"
                }`}
            />
            {error && <p className="mt-1 text-[11px] text-rose-600">{error}</p>}
        </div>
    );
}
