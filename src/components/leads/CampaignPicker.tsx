"use client";

// The acquisition-campaign field on every form that creates leads (tracker
// ID 81): which trade event, ad or list the dealer came in on. Shown once
// "Found via" is picked; REQUIRED for Trade event and Digital ad, where the
// origin means nothing without it. Managers can add a campaign here; everyone
// else picks from the list.

import { useEffect, useState } from "react";
import { campaignRequired, originLabel, SOURCE_LABELS } from "@/lib/leads/leadSourceVocab";

type Option = { id: string; name: string };

type Props = {
    /** The chosen "Found via" value; the list is that origin's open campaigns. */
    origin: string;
    /** Campaign id, "" for none. */
    value: string;
    onChange: (campaignId: string) => void;
    /** Shown under the field when it is optional (e.g. what a blank means). */
    hint?: string;
    /** Classes for the <select> and the new-campaign <input>, to match the host form. */
    controlClassName?: string;
    labelClassName?: string;
    className?: string;
};

const DEFAULT_CONTROL = "w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm";

export function CampaignPicker({
    origin,
    value,
    onChange,
    hint,
    controlClassName = DEFAULT_CONTROL,
    labelClassName = "block text-sm font-medium text-gray-700",
    className,
}: Props) {
    const [options, setOptions] = useState<Option[]>([]);
    const [canManage, setCanManage] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [adding, setAdding] = useState(false);
    const [newName, setNewName] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const required = campaignRequired(origin);

    useEffect(() => {
        if (!origin) return;
        let live = true;
        setLoaded(false);
        fetch(`/api/acquisition-campaigns?picker=1&origin=${encodeURIComponent(origin)}`, { cache: "no-store" })
            .then((r) => r.json())
            .then((json) => {
                if (!live) return;
                const list: Option[] = json?.data?.campaigns ?? [];
                setOptions(list);
                setCanManage(!!json?.data?.can_manage);
                // A campaign picked under another origin is not carried over.
                if (value && !list.some((c) => c.id === value)) onChange("");
            })
            .catch(() => live && setOptions([]))
            .finally(() => live && setLoaded(true));
        return () => {
            live = false;
        };
        // Reload on origin only: `value` / `onChange` change on every keystroke
        // of the host form.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [origin]);

    if (!origin) return null;

    const add = async () => {
        const name = newName.trim();
        if (name.length < 2) {
            setError("Give the campaign a name.");
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const res = await fetch("/api/acquisition-campaigns", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, origin }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Could not add the campaign");
            const created: Option = { id: json.data.id, name: json.data.name };
            setOptions((prev) => [created, ...prev]);
            onChange(created.id);
            setAdding(false);
            setNewName("");
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className={className}>
            <label className={labelClassName}>
                {SOURCE_LABELS.campaign}
                {required && <span className="text-rose-600"> *</span>}
            </label>
            {adding ? (
                <div className="mt-1 flex gap-2">
                    <input
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        placeholder={`New ${originLabel(origin)?.toLowerCase() ?? "campaign"} name`}
                        className={controlClassName}
                        autoFocus
                    />
                    <button
                        type="button"
                        onClick={add}
                        disabled={saving}
                        className="shrink-0 rounded-md bg-gray-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
                    >
                        {saving ? "Adding…" : "Add"}
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setAdding(false);
                            setError(null);
                        }}
                        disabled={saving}
                        className="shrink-0 rounded-md border border-gray-200 px-3 py-2 text-xs text-gray-600"
                    >
                        Cancel
                    </button>
                </div>
            ) : (
                <select
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    className={`mt-1 ${controlClassName}`}
                >
                    <option value="">{required ? "Select…" : "No campaign"}</option>
                    {options.map((c) => (
                        <option key={c.id} value={c.id}>
                            {c.name}
                        </option>
                    ))}
                </select>
            )}
            {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
            {!adding && canManage && (
                <button
                    type="button"
                    onClick={() => setAdding(true)}
                    className="mt-1 text-xs font-medium text-brand-700 hover:underline"
                >
                    + New campaign
                </button>
            )}
            {!adding && !canManage && required && loaded && options.length === 0 && (
                <p className="mt-1 text-xs text-amber-700">
                    No open campaign for {originLabel(origin)?.toLowerCase()} yet — ask your Sales Head to add it
                    under Acquisition Campaigns.
                </p>
            )}
            {!adding && !required && hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
        </div>
    );
}
