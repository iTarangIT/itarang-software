// Add a single prospect to dealer_leads, straight from the /leads page.
//
// WHY THIS EXISTS. Until now the only ways into the prospect pool were bulk:
// the Import modal, the Bulk Lead Upload wizard, the scraper. "New Lead" on
// this page goes to /leads/new, which is the 5-step LOAN-APPLICATION wizard
// against the `leads` table — a different entity entirely. So a rep who got one
// dealer's number on a call had nowhere to put it, and it went in a notebook.
//
// The live duplicate check is the point. It runs against the same four-outcome
// classifier the importers use (src/lib/leads/dedupe.ts), so the operator finds
// out about a collision — and which KIND of collision — while typing, rather
// than after submitting.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle, Loader2, Plus, X } from "lucide-react";

type DuplicateCheck = {
    valid: boolean;
    outcome: "valid" | "reactivate" | "address_mismatch" | "duplicate_skip" | null;
    normalizedPhone?: string;
    message: string | null;
    existing: {
        id?: string;
        dealer_name?: string | null;
        shop_name?: string | null;
        city?: string | null;
        lead_status?: string | null;
        current_owner_name?: string | null;
    } | null;
};

const EMPTY = {
    dealer_name: "",
    phone: "",
    shop_name: "",
    city: "",
    state: "",
    area: "",
    pincode: "",
    language: "hindi",
};

export function AddLeadModal({
    onClose,
    onSuccess,
}: {
    onClose: () => void;
    onSuccess: () => void;
}) {
    const [form, setForm] = useState({ ...EMPTY });
    const [dup, setDup] = useState<DuplicateCheck | null>(null);
    const [checking, setChecking] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);

    // Debounced so typing a 10-digit number is one request, not ten.
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const runCheck = useCallback(async (phone: string, city: string) => {
        if (phone.replace(/\D/g, "").length < 10) {
            setDup(null);
            return;
        }
        setChecking(true);
        try {
            const res = await fetch(
                `/api/dealer-leads/check-duplicate?phone=${encodeURIComponent(phone)}&city=${encodeURIComponent(city)}`,
            );
            const json = await res.json();
            setDup(json?.success ? json.data : null);
        } catch {
            // A failed pre-check must not block submission — the server
            // re-runs the same classification authoritatively on POST.
            setDup(null);
        } finally {
            setChecking(false);
        }
    }, []);

    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            void runCheck(form.phone, form.city);
        }, 400);
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, [form.phone, form.city, runCheck]);

    const set = (k: keyof typeof EMPTY, v: string) =>
        setForm((f) => ({ ...f, [k]: v }));

    const canSubmit =
        form.dealer_name.trim().length > 0 &&
        form.phone.replace(/\D/g, "").length >= 10 &&
        !saving;

    const handleSubmit = async () => {
        setSaving(true);
        setError(null);
        try {
            const res = await fetch("/api/dealer-leads", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(form),
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                setError(json?.error ?? "Could not create the lead.");
                return;
            }
            setDone(true);
            onSuccess();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Network error");
        } finally {
            setSaving(false);
        }
    };

    const banner = (() => {
        if (checking) {
            return (
                <div className="flex items-center gap-2 text-xs text-gray-500">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking for
                    duplicates…
                </div>
            );
        }
        if (!dup) return null;
        if (dup.valid) {
            return (
                <div className="flex items-center gap-2 text-xs text-emerald-600">
                    <CheckCircle className="w-3.5 h-3.5" /> New number — not in the
                    system yet.
                </div>
            );
        }
        const tone =
            dup.outcome === "reactivate"
                ? "bg-blue-50 border-blue-200 text-blue-800"
                : dup.outcome === "address_mismatch"
                  ? "bg-amber-50 border-amber-200 text-amber-800"
                  : "bg-gray-50 border-gray-200 text-gray-700";
        return (
            <div className={`rounded-lg border px-3 py-2 text-xs ${tone}`}>
                <div className="flex items-start gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <div>
                        <p className="font-medium">{dup.message}</p>
                        {dup.existing && (
                            <p className="mt-1 opacity-80">
                                {dup.existing.dealer_name ||
                                    dup.existing.shop_name ||
                                    dup.existing.id}
                                {dup.existing.city ? ` · ${dup.existing.city}` : ""}
                                {dup.existing.lead_status
                                    ? ` · ${dup.existing.lead_status}`
                                    : ""}
                                {dup.existing.current_owner_name
                                    ? ` · owned by ${dup.existing.current_owner_name}`
                                    : ""}
                            </p>
                        )}
                    </div>
                </div>
            </div>
        );
    })();

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg">
                <div className="flex items-center justify-between px-6 py-4 border-b">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 bg-gray-900 rounded-lg flex items-center justify-center">
                            <Plus className="w-4 h-4 text-white" />
                        </div>
                        <h2 className="text-sm font-semibold text-gray-900">
                            Add Lead
                        </h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
                    >
                        <X className="w-4 h-4 text-gray-500" />
                    </button>
                </div>

                {done ? (
                    <div className="p-8 text-center">
                        <div className="w-12 h-12 bg-emerald-50 rounded-2xl flex items-center justify-center mx-auto mb-3">
                            <CheckCircle className="w-6 h-6 text-emerald-600" />
                        </div>
                        <p className="text-base font-semibold text-gray-900 mb-1">
                            Lead added
                        </p>
                        <p className="text-sm text-gray-500">
                            {form.dealer_name} is now in the prospect pool.
                        </p>
                        <div className="mt-4 flex items-center justify-center gap-2">
                            <button
                                onClick={() => {
                                    setForm({ ...EMPTY });
                                    setDup(null);
                                    setDone(false);
                                }}
                                className="px-4 py-2 border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50"
                            >
                                Add another
                            </button>
                            <button
                                onClick={onClose}
                                className="px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-700"
                            >
                                Done
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="p-6 space-y-4">
                        <div className="grid grid-cols-2 gap-3">
                            <Field
                                label="Dealer name *"
                                value={form.dealer_name}
                                onChange={(v) => set("dealer_name", v)}
                                placeholder="Ramesh Kumar"
                            />
                            <Field
                                label="Phone *"
                                value={form.phone}
                                onChange={(v) => set("phone", v)}
                                placeholder="98765 43210"
                            />
                            <Field
                                label="Shop / business"
                                value={form.shop_name}
                                onChange={(v) => set("shop_name", v)}
                                placeholder="Sharada Enterprises"
                            />
                            <Field
                                label="City"
                                value={form.city}
                                onChange={(v) => set("city", v)}
                                placeholder="Ujjain"
                            />
                            <Field
                                label="State"
                                value={form.state}
                                onChange={(v) => set("state", v)}
                                placeholder="Madhya Pradesh"
                            />
                            <Field
                                label="Pincode"
                                value={form.pincode}
                                onChange={(v) => set("pincode", v)}
                                placeholder="456001"
                            />
                        </div>

                        <div className="min-h-[24px]">{banner}</div>

                        {error && (
                            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                                {error}
                            </div>
                        )}

                        <div className="flex items-center justify-end gap-2 pt-2">
                            <button
                                onClick={onClose}
                                className="px-4 py-2 border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSubmit}
                                disabled={!canSubmit}
                                className="px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                            >
                                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                Add lead
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function Field({
    label,
    value,
    onChange,
    placeholder,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
}) {
    return (
        <label className="block">
            <span className="text-xs font-medium text-gray-600">{label}</span>
            <input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
            />
        </label>
    );
}
