"use client";

// One dealer account: came-through badge, onboarded by, owner + reassign,
// owner history, GSTIN + aliases + Correct GSTIN (tracker P1-1 / P1-2).

import Link from "next/link";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CameThroughBadge } from "./AccountsView";
import { AssignOwnerDialog, api, fmtDate, inputCls } from "./shared";

type Detail = {
    account: {
        id: string;
        name: string;
        gstin: string | null;
        pan: string | null;
        gstin_missing: boolean;
        city: string | null;
        state: string | null;
        status: string;
        contact_name: string | null;
        contact_phone: string | null;
        contact_email: string | null;
        created_at: string | null;
        owner_user_id: string | null;
        owner_name: string | null;
        onboarded_by_user_id: string | null;
        onboarded_by_name: string | null;
        came_through: "lead" | "direct" | null;
    };
    application: { id: string; company_name: string | null; gst_number: string | null; onboarding_status: string | null } | null;
    lead: { id: string; name: string | null; lead_status: string | null; gstin: string | null } | null;
    gstin_aliases: Array<{ gstin: string; source: string; created_at: string | null; added_by_name: string | null }>;
    gst_certificates: Array<{ id: string; document_type: string; file_name: string; file_url: string | null; uploaded_at: string | null }>;
    has_gst_certificate: boolean;
    owner_history: Array<{
        id: string;
        owner_user_id: string | null;
        owner_name: string | null;
        effective_from: string | null;
        effective_to: string | null;
        reason: string | null;
        changed_by_name: string | null;
        created_at: string | null;
    }>;
    suggested_owner: { user_id: string; name: string | null; basis: string } | null;
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <div className="text-[11px] uppercase tracking-wide text-ink-muted">{label}</div>
            <div className="mt-0.5 text-sm text-ink">{children}</div>
        </div>
    );
}

export function AccountDetailView({ accountId }: { accountId: string }) {
    const qc = useQueryClient();
    const key = ["admin-account", accountId];
    const { data, isLoading, error } = useQuery<Detail>({
        queryKey: key,
        queryFn: () => api(`/api/admin/accounts/${encodeURIComponent(accountId)}`),
    });
    const [assignOpen, setAssignOpen] = useState(false);
    const [flash, setFlash] = useState<string | null>(null);

    const refresh = (msg: string) => {
        setFlash(msg);
        qc.invalidateQueries({ queryKey: key });
        qc.invalidateQueries({ queryKey: ["admin-accounts"] });
    };

    if (isLoading) {
        return (
            <div className="flex items-center gap-2 text-sm text-ink-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
        );
    }
    if (error || !data) return <p className="text-sm text-rose-600">{(error as Error)?.message ?? "Not found"}</p>;

    const a = data.account;

    return (
        <div className="space-y-5">
            <Link href="/admin/accounts" className="inline-flex items-center gap-1 text-xs text-ink-muted hover:underline">
                <ArrowLeft className="h-3 w-3" /> All accounts
            </Link>

            <header className="flex flex-wrap items-start gap-3">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-ink">{a.name}</h1>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                        <span className="font-mono">{a.id}</span>
                        <CameThroughBadge value={a.came_through} />
                        {a.status !== "active" && <span className="rounded-full border border-border px-2 py-0.5">{a.status}</span>}
                    </div>
                </div>
            </header>

            {flash && (
                <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                    <span>{flash}</span>
                    <button type="button" className="underline" onClick={() => setFlash(null)}>
                        Dismiss
                    </button>
                </div>
            )}

            <section className="grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-card sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Owner">
                    {a.owner_user_id ? (
                        a.owner_name ?? a.owner_user_id
                    ) : (
                        <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                            No owner
                        </span>
                    )}
                    {!a.owner_user_id && data.suggested_owner && (
                        <div className="mt-1 text-[11px] text-ink-muted">
                            Suggested: {data.suggested_owner.name ?? data.suggested_owner.user_id} ({data.suggested_owner.basis})
                        </div>
                    )}
                    <div className="mt-2">
                        <Button size="sm" variant="outline" onClick={() => setAssignOpen(true)}>
                            {a.owner_user_id ? "Reassign" : "Assign owner"}
                        </Button>
                    </div>
                </Field>
                <Field label="Onboarded by">{a.onboarded_by_name ?? "—"}</Field>
                <Field label="Came through">
                    {a.came_through === "lead" ? "Lead" : a.came_through === "direct" ? "Direct onboarding" : "Not recorded"}
                    {data.lead && (
                        <div className="mt-1 text-xs">
                            <Link href={`/leads/${encodeURIComponent(data.lead.id)}`} className="text-blue-700 hover:underline">
                                {data.lead.name ?? data.lead.id}
                            </Link>
                            {data.lead.lead_status ? <span className="text-ink-muted"> · {data.lead.lead_status}</span> : null}
                        </div>
                    )}
                    {data.application && (
                        <div className="mt-1 text-xs">
                            <Link
                                href={`/admin/dealer-verification/${encodeURIComponent(data.application.id)}`}
                                className="text-blue-700 hover:underline"
                            >
                                Onboarding application
                            </Link>
                            {data.application.onboarding_status ? (
                                <span className="text-ink-muted"> · {data.application.onboarding_status}</span>
                            ) : null}
                        </div>
                    )}
                </Field>
                <Field label="Location / created">
                    {[a.city, a.state].filter(Boolean).join(", ") || "—"}
                    <div className="text-xs text-ink-muted">Created {fmtDate(a.created_at)}</div>
                </Field>
                <Field label="Contact">
                    {a.contact_name ?? "—"}
                    <div className="text-xs text-ink-muted">{[a.contact_phone, a.contact_email].filter(Boolean).join(" · ")}</div>
                </Field>
            </section>

            <GstinSection data={data} onDone={refresh} />

            <section className="space-y-2">
                <h2 className="text-sm font-semibold text-ink">Owner history</h2>
                <div className="rounded-xl border border-border bg-surface shadow-card overflow-x-auto">
                    <table className="w-full min-w-[720px] text-sm">
                        <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                            <tr>
                                <th className="px-3 py-2 text-left font-semibold">Owner</th>
                                <th className="px-3 py-2 text-left font-semibold">From</th>
                                <th className="px-3 py-2 text-left font-semibold">To</th>
                                <th className="px-3 py-2 text-left font-semibold">Reason</th>
                                <th className="px-3 py-2 text-left font-semibold">Changed by</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {data.owner_history.length === 0 && (
                                <tr>
                                    <td colSpan={5} className="px-3 py-6 text-center text-ink-muted">
                                        No owner has ever been assigned.
                                    </td>
                                </tr>
                            )}
                            {data.owner_history.map((h) => (
                                <tr key={h.id}>
                                    <td className="px-3 py-2 text-ink">{h.owner_user_id ? (h.owner_name ?? h.owner_user_id) : <i className="text-ink-muted">No owner</i>}</td>
                                    <td className="px-3 py-2">{fmtDate(h.effective_from)}</td>
                                    <td className="px-3 py-2">{h.effective_to ? fmtDate(h.effective_to) : <span className="text-emerald-700">current</span>}</td>
                                    <td className="px-3 py-2 text-ink-muted">{h.reason ?? "—"}</td>
                                    <td className="px-3 py-2 text-ink-muted">
                                        {h.changed_by_name ?? "—"}
                                        <div className="text-[11px]">{fmtDate(h.created_at)}</div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            {assignOpen && (
                <AssignOwnerDialog
                    title={a.owner_user_id ? `Reassign ${a.name}` : `Assign owner · ${a.name}`}
                    accountIds={[a.id]}
                    initialOwnerId={!a.owner_user_id ? data.suggested_owner?.user_id : undefined}
                    onClose={() => setAssignOpen(false)}
                    onDone={(msg) => {
                        setAssignOpen(false);
                        refresh(msg);
                    }}
                />
            )}
        </div>
    );
}

function GstinSection({ data, onDone }: { data: Detail; onDone: (msg: string) => void }) {
    const a = data.account;
    const [open, setOpen] = useState(false);
    const [gstin, setGstin] = useState("");
    const [reason, setReason] = useState("");
    const [file, setFile] = useState<File | null>(null);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const needsCert = !data.has_gst_certificate;

    const submit = async () => {
        setErr(null);
        if (!gstin.trim()) return setErr("Enter the correct GSTIN.");
        if (!reason.trim()) return setErr("A reason is required.");
        if (needsCert && !file) return setErr("No GST certificate is on file — attach one.");
        setBusy(true);
        try {
            const form = new FormData();
            form.set("gstin", gstin.trim());
            form.set("reason", reason.trim());
            if (file) form.set("certificate", file);
            const r = await api<{ gstin: string; previous_gstin: string | null; kept_old_as_alias: boolean; warnings: string[] }>(
                `/api/admin/accounts/${encodeURIComponent(a.id)}/gstin`,
                { method: "PATCH", body: form },
            );
            setOpen(false);
            setGstin("");
            setReason("");
            setFile(null);
            onDone(
                `GSTIN updated to ${r.gstin}` +
                    (r.kept_old_as_alias ? ` · ${r.previous_gstin} kept so its invoices still match` : "") +
                    (r.warnings.length ? ` · ${r.warnings.join(" ")}` : ""),
            );
        } catch (e) {
            setErr((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="space-y-3 rounded-xl border border-border bg-surface p-4 shadow-card">
            <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-sm font-semibold text-ink">GSTIN</h2>
                {a.gstin_missing ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700">
                        <AlertTriangle className="h-3 w-3" /> GSTIN missing{a.gstin ? ` (${a.gstin})` : ""}
                    </span>
                ) : (
                    <span className="font-mono text-sm text-ink">{a.gstin}</span>
                )}
                <Button size="sm" variant="outline" className="ml-auto" onClick={() => setOpen((o) => !o)}>
                    {open ? "Cancel" : "Correct GSTIN"}
                </Button>
            </div>

            {data.gstin_aliases.length > 0 && (
                <div className="text-xs text-ink-muted">
                    <div className="mb-1 font-medium">Also matched (earlier / linked GSTINs):</div>
                    <ul className="space-y-0.5">
                        {data.gstin_aliases.map((g) => (
                            <li key={g.gstin}>
                                <span className="font-mono text-ink">{g.gstin}</span> · {g.source === "correction" ? "before correction" : "linked from an invoice"}
                                {g.added_by_name ? ` · ${g.added_by_name}` : ""} · {fmtDate(g.created_at)}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <div className="text-xs text-ink-muted">
                GST certificate:{" "}
                {data.gst_certificates.length > 0
                    ? data.gst_certificates.map((c, i) => (
                          <span key={c.id}>
                              {i > 0 ? ", " : ""}
                              {c.file_url ? (
                                  <a href={c.file_url} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">
                                      {c.file_name}
                                  </a>
                              ) : (
                                  c.file_name
                              )}
                          </span>
                      ))
                    : "none on file"}
            </div>

            {open && (
                <div className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
                    <label className="block space-y-1">
                        <span className="text-xs font-medium text-ink-muted">Correct GSTIN</span>
                        <input
                            className={`${inputCls} font-mono uppercase`}
                            value={gstin}
                            maxLength={20}
                            onChange={(e) => setGstin(e.target.value)}
                            placeholder="27ABCDE1234F1Z5"
                        />
                    </label>
                    <label className="block space-y-1">
                        <span className="text-xs font-medium text-ink-muted">Reason</span>
                        <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Typo at onboarding" />
                    </label>
                    {needsCert && (
                        <label className="block space-y-1 sm:col-span-2">
                            <span className="text-xs font-medium text-ink-muted">
                                GST certificate (required — none on file for this account)
                            </span>
                            <input
                                type="file"
                                accept="application/pdf,image/jpeg,image/png,image/webp"
                                className="block text-sm"
                                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                            />
                        </label>
                    )}
                    <p className="text-xs text-ink-muted sm:col-span-2">
                        The current GSTIN is kept as an earlier GSTIN, so invoices raised under it still count for this account.
                    </p>
                    {err && <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 sm:col-span-2">{err}</p>}
                    <div className="sm:col-span-2">
                        <Button size="sm" onClick={submit} disabled={busy}>
                            {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Save GSTIN
                        </Button>
                    </div>
                </div>
            )}
        </section>
    );
}
