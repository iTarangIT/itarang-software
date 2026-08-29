"use client";

/**
 * E-259 — scrap payment terms, one per NBFC.
 *
 * TWO-PANE, NOT A TABLE OF DROPDOWNS. The question this screen answers is
 * "when do we pay THIS NBFC", asked about one counterparty at a time. A grid
 * of selects invites a mis-click on the wrong row and gives the consequence —
 * which is money — nowhere to be spelled out. So: pick the NBFC on the left,
 * read what each term actually does on the right, choose one.
 *
 * SAVING IS EXPLICIT. Nothing is written on selection. A payment term is not a
 * preference toggle; the admin should be able to click through the options and
 * read them without changing anything.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, PackageCheck, Search, Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Timing = "pre_lot" | "post_lot";

type Term = {
    tenant_id: string;
    tenant_name: string;
    is_active: boolean;
    timing: Timing;
    /** False when the value shown is the default, not a decision anyone took. */
    is_set: boolean;
    note: string | null;
    updated_at: string | null;
};

const OPTIONS: {
    value: Timing;
    label: string;
    icon: typeof Wallet;
    what: string;
    when: string;
}[] = [
        {
            value: "pre_lot",
            label: "Pre-lot — pay before the batteries arrive",
            icon: Wallet,
            what:
                "iTarang releases the payment as soon as the rate is agreed, while the batteries are still with the NBFC.",
            when:
                "For NBFCs whose lots have arrived as described before. The money moves first, so a lot that never turns up is money already gone.",
        },
        {
            value: "post_lot",
            label: "Post-lot — pay after the batteries arrive",
            icon: PackageCheck,
            what:
                "The payout stays blocked until an admin marks the consignment received at iTarang on the Scrap Purchase desk.",
            when:
                "The default, and the safer term. Nothing leaves the account until somebody here has the batteries in hand.",
        },
    ];

function when(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
        ? ""
        : d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

export function ScrapPaymentTermsForm() {
    const qc = useQueryClient();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [draft, setDraft] = useState<Timing | null>(null);
    const [note, setNote] = useState("");
    const [filter, setFilter] = useState("");
    const [saving, setSaving] = useState(false);

    const { data, isLoading, error } = useQuery({
        queryKey: ["scrap-payment-terms"],
        queryFn: async () => {
            const res = await fetch("/api/admin/settings/nbfc-scrap-payments", {
                cache: "no-store",
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            return (body.data ?? body) as { terms: Term[]; defaultTiming: Timing };
        },
    });

    const terms = useMemo(() => data?.terms ?? [], [data]);

    const visible = useMemo(() => {
        const q = filter.trim().toLowerCase();
        return q
            ? terms.filter((t) => t.tenant_name.toLowerCase().includes(q))
            : terms;
    }, [terms, filter]);

    // Select the first NBFC once the list lands, so the right pane is never an
    // empty box the admin has to work out how to fill.
    useEffect(() => {
        if (!selectedId && visible.length > 0) setSelectedId(visible[0].tenant_id);
    }, [visible, selectedId]);

    const selected = terms.find((t) => t.tenant_id === selectedId) ?? null;

    // Reset the draft whenever the selection changes, so a term half-chosen for
    // one NBFC cannot be saved against another.
    useEffect(() => {
        setDraft(selected?.timing ?? null);
        setNote(selected?.note ?? "");
    }, [selected?.tenant_id, selected?.timing, selected?.note]);

    const dirty =
        selected != null &&
        draft != null &&
        (draft !== selected.timing ||
            (note.trim() || null) !== (selected.note ?? null) ||
            !selected.is_set);

    async function save() {
        if (!selected || !draft) return;
        setSaving(true);
        try {
            const res = await fetch("/api/admin/settings/nbfc-scrap-payments", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    tenantId: selected.tenant_id,
                    timing: draft,
                    note: note.trim() || null,
                }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            toast.success(
                draft === "pre_lot"
                    ? `${selected.tenant_name} is now paid before the lot arrives`
                    : `${selected.tenant_name} is now paid after the lot arrives`,
            );
            await qc.invalidateQueries({ queryKey: ["scrap-payment-terms"] });
        } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    }

    if (isLoading) {
        return (
            <div className="flex items-center gap-2 text-sm text-ink-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading NBFCs…
            </div>
        );
    }

    if (error) {
        return (
            <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
                {error instanceof Error ? error.message : String(error)}
            </p>
        );
    }

    if (terms.length === 0) {
        return (
            <p className="text-sm text-ink-muted">
                No NBFCs are onboarded yet. Once one is, its scrap payment term can
                be set here.
            </p>
        );
    }

    return (
        <div className="grid gap-5 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
            {/* — who — */}
            <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                    NBFC
                </label>
                <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
                    <Input
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Find an NBFC"
                        className="pl-8"
                    />
                </div>
                <div className="max-h-[22rem] divide-y divide-border overflow-y-auto rounded-lg border border-border">
                    {visible.map((t) => {
                        const active = t.tenant_id === selectedId;
                        return (
                            <button
                                key={t.tenant_id}
                                type="button"
                                onClick={() => setSelectedId(t.tenant_id)}
                                className={
                                    active
                                        ? "flex w-full flex-col items-start gap-0.5 bg-slate-900 px-3 py-2 text-left text-white"
                                        : "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-slate-50"
                                }
                            >
                                <span className="truncate text-sm font-medium">
                                    {t.tenant_name}
                                </span>
                                <span
                                    className={
                                        active
                                            ? "text-[11px] text-white/70"
                                            : "text-[11px] text-ink-muted"
                                    }
                                >
                                    {t.timing === "pre_lot" ? "Pre-lot" : "Post-lot"}
                                    {t.is_set ? "" : " · default"}
                                    {t.is_active ? "" : " · inactive"}
                                </span>
                            </button>
                        );
                    })}
                    {visible.length === 0 ? (
                        <p className="px-3 py-3 text-sm text-ink-muted">
                            No NBFC matches “{filter}”.
                        </p>
                    ) : null}
                </div>
            </div>

            {/* — what term — */}
            <div className="space-y-3">
                {selected ? (
                    <>
                        <div>
                            <h2 className="text-base font-semibold text-ink">
                                {selected.tenant_name}
                            </h2>
                            <p className="text-xs text-ink-muted">
                                {selected.is_set && selected.updated_at
                                    ? `Term last changed ${when(selected.updated_at)}`
                                    : "No term has been set — the default below applies."}
                            </p>
                        </div>

                        <div className="space-y-2">
                            {OPTIONS.map((o) => {
                                const picked = draft === o.value;
                                const Icon = o.icon;
                                return (
                                    <label
                                        key={o.value}
                                        className={
                                            picked
                                                ? "flex cursor-pointer gap-3 rounded-lg border-2 border-slate-900 bg-slate-50 p-3"
                                                : "flex cursor-pointer gap-3 rounded-lg border border-border p-3 hover:bg-slate-50"
                                        }
                                    >
                                        <input
                                            type="radio"
                                            name="scrap-payment-timing"
                                            className="mt-1"
                                            checked={picked}
                                            onChange={() => setDraft(o.value)}
                                        />
                                        <div className="space-y-1">
                                            <span className="flex items-center gap-2 text-sm font-medium text-ink">
                                                <Icon className="h-4 w-4" />
                                                {o.label}
                                            </span>
                                            <p className="text-xs text-ink-muted">{o.what}</p>
                                            <p className="text-xs text-ink-muted">{o.when}</p>
                                        </div>
                                    </label>
                                );
                            })}
                        </div>

                        <label className="block text-sm">
                            <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                                Note (optional)
                            </span>
                            <Input
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                placeholder="Why this term — e.g. “pre-lot until the first three lots clear”"
                                className="mt-1"
                            />
                        </label>

                        <div className="flex items-center gap-3">
                            <Button type="button" onClick={save} disabled={!dirty || saving}>
                                {saving ? "Saving…" : "Save term"}
                            </Button>
                            {dirty ? (
                                <span className="text-xs text-ink-muted">Not saved yet.</span>
                            ) : null}
                        </div>

                        <p className="rounded-lg bg-slate-50 p-3 text-xs text-ink-muted">
                            The term is read when the payment is released, not when the
                            consignment is created — changing it here also binds deals
                            already under negotiation with this NBFC.
                        </p>
                    </>
                ) : null}
            </div>
        </div>
    );
}

export default ScrapPaymentTermsForm;
