"use client";

// Tracker ID 65 — the Account management list with its actions: assign or
// reassign the ticked accounts, move one person's accounts to another, correct
// a GSTIN, and read an account's ownership history. Every owner change posts a
// reason and an effective date.

import { Fragment, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AccountRow } from "@/lib/accounts/accountList";
import type { OwnershipHistoryRow } from "@/lib/accounts/accountOwner";
import type { AccountBucket } from "@/lib/dealers/accountHealthRules";

type Option = { id: string; label: string };

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const inputCls = "rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-sm text-gray-700";
const BUCKET_TONE: Record<AccountBucket, string> = {
    active: "bg-emerald-50 text-emerald-700",
    cooling: "bg-sky-50 text-sky-700",
    orange: "bg-orange-50 text-orange-700",
    red: "bg-rose-50 text-rose-700",
    dormant: "bg-gray-100 text-gray-600",
    not_ordered_yet: "bg-amber-50 text-amber-700",
    never_ordered: "bg-gray-100 text-gray-600",
};

async function post(url: string, body: unknown): Promise<{ ok: boolean; data?: any; message?: string }> {
    try {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const json = await res.json();
        return res.ok && json.success ? { ok: true, data: json.data } : { ok: false, message: json?.error?.message ?? "Request failed" };
    } catch {
        return { ok: false, message: "Could not reach the server." };
    }
}

export function AccountManagementTable({
    rows,
    owners,
    currentOwners,
    bucketLabels,
}: {
    rows: AccountRow[];
    /** Who may own an account: active ISR, ASM and Sales Head. */
    owners: Option[];
    /** Who owns accounts today, including people no longer active (for the leaver move). */
    currentOwners: Option[];
    bucketLabels: Record<AccountBucket, string>;
}) {
    const router = useRouter();
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [ownerId, setOwnerId] = useState("");
    const [reason, setReason] = useState("");
    const [effective, setEffective] = useState("");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

    const [leaverOpen, setLeaverOpen] = useState(false);
    const [leaver, setLeaver] = useState({ from: "", to: "", reason: "", effective: "" });

    const [gstinFor, setGstinFor] = useState<string | null>(null);
    const [gstin, setGstin] = useState("");
    const [certificate, setCertificate] = useState<File | null>(null);
    const [certificateRead, setCertificateRead] = useState<{ gstin: string | null; summary: string | null; is_gst_certificate: boolean } | null>(null);
    const [reading, setReading] = useState(false);
    const [gstinCorrected, setGstinCorrected] = useState<{ at: string; by: string | null } | null>(null);
    const [historyFor, setHistoryFor] = useState<string | null>(null);
    const [history, setHistory] = useState<OwnershipHistoryRow[] | null>(null);

    const toggle = (id: string) =>
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.account_id));

    const done = (text: string) => {
        setMessage({ tone: "ok", text });
        setSelected(new Set());
        setReason("");
        router.refresh();
    };

    const assign = async () => {
        setBusy(true);
        const r = await post("/api/admin/account-management/assign", {
            account_ids: [...selected],
            owner_id: ownerId,
            reason,
            effective_date: effective || null,
        });
        setBusy(false);
        if (!r.ok) return setMessage({ tone: "error", text: r.message! });
        done(
            `${r.data.changed} account${r.data.changed === 1 ? "" : "s"} assigned.` +
                (r.data.unchanged ? ` ${r.data.unchanged} already had this owner.` : ""),
        );
    };

    const moveLeaver = async () => {
        setBusy(true);
        const r = await post("/api/admin/accounts/move-leaver", {
            from_owner_id: leaver.from,
            to_owner_id: leaver.to,
            reason: leaver.reason,
            effective_date: leaver.effective || null,
        });
        setBusy(false);
        if (!r.ok) return setMessage({ tone: "error", text: r.message! });
        setLeaverOpen(false);
        setLeaver({ from: "", to: "", reason: "", effective: "" });
        done(`${r.data.changed} account${r.data.changed === 1 ? "" : "s"} moved.`);
    };

    const correctGstin = async (accountId: string) => {
        setBusy(true);
        let r: { ok: boolean; data?: any; message?: string };
        if (certificate) {
            // The certificate travels with the correction, so a GSTIN is never
            // saved against an account that holds no certificate.
            const body = new FormData();
            body.append("gstin", gstin);
            body.append("file", certificate);
            try {
                const res = await fetch(`/api/admin/accounts/${encodeURIComponent(accountId)}/correct-gstin`, { method: "POST", body });
                const json = await res.json();
                r = res.ok && json.success ? { ok: true, data: json.data } : { ok: false, message: json?.error?.message ?? "Request failed" };
            } catch {
                r = { ok: false, message: "Could not reach the server." };
            }
        } else {
            r = await post(`/api/admin/accounts/${encodeURIComponent(accountId)}/correct-gstin`, { gstin });
        }
        setBusy(false);
        if (!r.ok) return setMessage({ tone: "error", text: r.message! });
        setGstinFor(null);
        setGstin("");
        setCertificate(null);
        setCertificateRead(null);
        if (r.data.certificate === "failed") {
            setSelected(new Set());
            router.refresh();
            return setMessage({ tone: "error", text: `GSTIN set to ${r.data.gstin}, but the certificate could not be stored. Upload it again.` });
        }
        done(`GSTIN set to ${r.data.gstin}.${r.data.certificate === "saved" ? " Certificate saved." : ""}`);
    };

    // Read the GSTIN printed on the chosen certificate and offer it — the
    // person still confirms it by pressing Save.
    const pickCertificate = async (accountId: string, file: File | null) => {
        setCertificate(file);
        setCertificateRead(null);
        if (!file) return;
        setReading(true);
        try {
            const body = new FormData();
            body.append("file", file);
            const res = await fetch(`/api/admin/accounts/${encodeURIComponent(accountId)}/gst-certificate?read=1`, { method: "POST", body });
            const json = await res.json();
            if (res.ok && json.success) {
                const read = json.data as { gstin: string | null; summary: string | null; is_gst_certificate: boolean };
                setCertificateRead(read);
                if (read.gstin) setGstin((current) => current || read.gstin!);
            }
        } catch {
            // Reading is a convenience; the GSTIN can still be typed.
        }
        setReading(false);
    };

    const uploadCertificate = async (accountId: string) => {
        if (!certificate) return;
        setBusy(true);
        const body = new FormData();
        body.append("file", certificate);
        let r: { ok: boolean; message?: string };
        try {
            const res = await fetch(`/api/admin/accounts/${encodeURIComponent(accountId)}/gst-certificate`, { method: "POST", body });
            const json = await res.json();
            r = res.ok && json.success ? { ok: true } : { ok: false, message: json?.error?.message ?? "Upload failed" };
        } catch {
            r = { ok: false, message: "Could not reach the server." };
        }
        setBusy(false);
        if (!r.ok) return setMessage({ tone: "error", text: r.message! });
        setCertificate(null);
        setCertificateRead(null);
        setGstinFor(null);
        done("GST certificate saved on the account's onboarding.");
    };

    const showHistory = async (accountId: string) => {
        if (historyFor === accountId) return setHistoryFor(null);
        setHistoryFor(accountId);
        setHistory(null);
        setGstinCorrected(null);
        try {
            const json = await fetch(`/api/admin/accounts/${encodeURIComponent(accountId)}/history`).then((r) => r.json());
            setHistory(json?.data?.history ?? []);
            setGstinCorrected(json?.data?.gstin_corrected ?? null);
        } catch {
            setHistory([]);
        }
    };

    const canAssign = selected.size > 0 && ownerId && reason.trim().length >= 5 && !busy;
    const canMove = leaver.from && leaver.to && leaver.from !== leaver.to && leaver.reason.trim().length >= 5 && !busy;

    return (
        <div className="space-y-3">
            {message && (
                <p
                    className={`rounded-lg border px-3 py-2 text-sm ${
                        message.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"
                    }`}
                >
                    {message.text}
                </p>
            )}

            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white p-3">
                {selected.size > 0 ? (
                    <>
                        <span className="text-sm font-semibold text-gray-800">{selected.size} selected</span>
                        <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={inputCls} aria-label="New owner">
                            <option value="">Assign to…</option>
                            {owners.map((o) => (
                                <option key={o.id} value={o.id}>
                                    {o.label}
                                </option>
                            ))}
                        </select>
                        <input
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="Reason (required)"
                            className={`${inputCls} min-w-[220px] flex-1`}
                        />
                        <label className="flex items-center gap-1.5 text-xs text-gray-500">
                            Effective
                            <input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} className={inputCls} />
                        </label>
                        <button
                            type="button"
                            disabled={!canAssign}
                            onClick={assign}
                            className="rounded-lg bg-gray-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
                        >
                            {busy ? "Saving…" : "Assign"}
                        </button>
                        <button type="button" onClick={() => setSelected(new Set())} className="text-sm text-gray-500 underline">
                            Clear
                        </button>
                    </>
                ) : (
                    <p className="text-xs text-gray-500">
                        Tick one or more accounts to assign or reassign them. The effective date defaults to today.
                    </p>
                )}
                <button
                    type="button"
                    onClick={() => setLeaverOpen((v) => !v)}
                    className="ml-auto rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                >
                    Move a person&apos;s accounts
                </button>
            </div>

            {leaverOpen && (
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
                    <span className="text-sm font-semibold text-amber-900">Move every account owned by</span>
                    <select value={leaver.from} onChange={(e) => setLeaver({ ...leaver, from: e.target.value })} className={inputCls}>
                        <option value="">Current owner…</option>
                        {currentOwners.map((o) => (
                            <option key={o.id} value={o.id}>
                                {o.label}
                            </option>
                        ))}
                    </select>
                    <span className="text-sm text-amber-900">to</span>
                    <select value={leaver.to} onChange={(e) => setLeaver({ ...leaver, to: e.target.value })} className={inputCls}>
                        <option value="">New owner…</option>
                        {owners
                            .filter((o) => o.id !== leaver.from)
                            .map((o) => (
                                <option key={o.id} value={o.id}>
                                    {o.label}
                                </option>
                            ))}
                    </select>
                    <input
                        value={leaver.reason}
                        onChange={(e) => setLeaver({ ...leaver, reason: e.target.value })}
                        placeholder="Reason (required)"
                        className={`${inputCls} min-w-[200px] flex-1`}
                    />
                    <input
                        type="date"
                        value={leaver.effective}
                        onChange={(e) => setLeaver({ ...leaver, effective: e.target.value })}
                        className={inputCls}
                        aria-label="Effective date"
                    />
                    <button
                        type="button"
                        disabled={!canMove}
                        onClick={moveLeaver}
                        className="rounded-lg bg-amber-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
                    >
                        {busy ? "Moving…" : "Move all"}
                    </button>
                </div>
            )}

            {rows.length === 0 ? (
                <p className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">No dealer account matches these filters.</p>
            ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
                    <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                            <tr>
                                <th className="w-8 px-3 py-2">
                                    <input
                                        type="checkbox"
                                        aria-label="Select all"
                                        checked={allSelected}
                                        onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.account_id)))}
                                    />
                                </th>
                                <th className="px-3 py-2">Dealer</th>
                                <th className="px-3 py-2">GSTIN</th>
                                <th className="px-3 py-2">City</th>
                                <th className="px-3 py-2">Onboarded on</th>
                                <th className="px-3 py-2">Came through</th>
                                <th className="px-3 py-2">Onboarded by</th>
                                <th className="px-3 py-2">Account owner</th>
                                <th className="px-3 py-2">Last invoice</th>
                                <th className="px-3 py-2">Health</th>
                                <th className="px-3 py-2 text-right">Billed, 90 days</th>
                                <th className="px-3 py-2" />
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {rows.map((r) => (
                                <Fragment key={r.account_id}>
                                    <tr className="align-top hover:bg-gray-50">
                                        <td className="px-3 py-2">
                                            <input
                                                type="checkbox"
                                                aria-label={`Select ${r.dealer}`}
                                                checked={selected.has(r.account_id)}
                                                onChange={() => toggle(r.account_id)}
                                            />
                                        </td>
                                        <td className="px-3 py-2">
                                            {r.application_id ? (
                                                <Link href={`/admin/dealer-verification/${r.application_id}`} className="font-medium text-blue-700 underline">
                                                    {r.dealer}
                                                </Link>
                                            ) : (
                                                <span className="font-medium text-gray-900">{r.dealer}</span>
                                            )}
                                            <div className="text-xs text-gray-400">{r.account_id}</div>
                                        </td>
                                        <td className="px-3 py-2">
                                            {r.gstin_missing ? (
                                                <span className="rounded bg-rose-50 px-1.5 py-0.5 text-xs font-semibold text-rose-700">GSTIN missing</span>
                                            ) : (
                                                <span className="tabular-nums text-gray-700">{r.gstin}</span>
                                            )}
                                        </td>
                                        <td className="px-3 py-2 text-gray-600">{[r.city, r.state].filter(Boolean).join(", ") || "—"}</td>
                                        <td className="px-3 py-2 text-gray-600">{r.activated_on ?? "—"}</td>
                                        <td className="px-3 py-2 text-gray-600">
                                            {r.came_through === "lead" && r.lead_id ? (
                                                <Link href={`/leads/${encodeURIComponent(r.lead_id)}`} className="text-blue-700 underline">
                                                    Lead
                                                </Link>
                                            ) : r.came_through === "direct" ? (
                                                "Direct onboarding"
                                            ) : (
                                                "—"
                                            )}
                                        </td>
                                        <td className="px-3 py-2 text-gray-600">{r.onboarded_by_name ?? "—"}</td>
                                        <td className="px-3 py-2">
                                            {r.owner_name ? (
                                                <>
                                                    <span className="text-gray-800">{r.owner_name}</span>
                                                    {r.owner_since && <div className="text-xs text-gray-400">since {r.owner_since}</div>}
                                                </>
                                            ) : (
                                                <>
                                                    <span className="font-semibold text-rose-700">No owner</span>
                                                    {r.suggested_owner_name && (
                                                        <div className="text-xs text-gray-500">
                                                            Suggested: {r.suggested_owner_name}
                                                            <span className="text-gray-400"> ({r.suggested_owner_why})</span>{" "}
                                                            <button
                                                                type="button"
                                                                className="text-blue-700 underline"
                                                                onClick={() => {
                                                                    setSelected(new Set([r.account_id]));
                                                                    setOwnerId(r.suggested_owner_id ?? "");
                                                                }}
                                                            >
                                                                Use
                                                            </button>
                                                        </div>
                                                    )}
                                                </>
                                            )}
                                        </td>
                                        <td className="px-3 py-2 text-gray-600">
                                            {r.last_order ?? "—"}
                                            {r.days_since_last_order != null && (
                                                <div className="text-xs text-gray-400">{r.days_since_last_order} days ago</div>
                                            )}
                                        </td>
                                        <td className="px-3 py-2">
                                            <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${BUCKET_TONE[r.bucket]}`}>
                                                {bucketLabels[r.bucket]}
                                            </span>
                                            {r.invoices_unmatchable && (
                                                <div className="mt-0.5 text-xs text-amber-700">Invoices cannot be matched until a GSTIN is set</div>
                                            )}
                                        </td>
                                        <td className="px-3 py-2 text-right tabular-nums text-gray-700">{inr(r.revenue_90d)}</td>
                                        <td className="px-3 py-2 text-right text-xs whitespace-nowrap">
                                            <button
                                                type="button"
                                                className="text-blue-700 underline"
                                                onClick={() => {
                                                    setGstinFor(gstinFor === r.account_id ? null : r.account_id);
                                                    setCertificate(null);
                                                    setCertificateRead(null);
                                                    setGstin(r.gstin_missing ? "" : (r.gstin ?? ""));
                                                }}
                                            >
                                                Correct GSTIN
                                            </button>
                                            <span className="mx-1 text-gray-300">|</span>
                                            <button type="button" className="text-blue-700 underline" onClick={() => showHistory(r.account_id)}>
                                                History
                                            </button>
                                        </td>
                                    </tr>
                                    {gstinFor === r.account_id && (
                                        <tr className="bg-gray-50">
                                            <td />
                                            <td colSpan={11} className="px-3 py-3">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <input
                                                        value={gstin}
                                                        onChange={(e) => setGstin(e.target.value.toUpperCase().replace(/\s/g, "").slice(0, 15))}
                                                        placeholder="15-character GSTIN"
                                                        className={`${inputCls} w-52 tabular-nums`}
                                                    />
                                                    <button
                                                        type="button"
                                                        disabled={
                                                            busy ||
                                                            reading ||
                                                            gstin.length !== 15 ||
                                                            (!!r.application_id && !r.gst_certificate_on_file && !certificate)
                                                        }
                                                        onClick={() => correctGstin(r.account_id)}
                                                        className="rounded-lg bg-gray-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
                                                    >
                                                        {busy ? "Saving…" : certificate ? "Save GSTIN and certificate" : "Save GSTIN"}
                                                    </button>
                                                    <span className="text-xs text-gray-500">Saved on the account, not the onboarding.</span>
                                                </div>
                                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                                    <span className={`text-xs ${r.gst_certificate_on_file || !r.application_id ? "text-gray-500" : "font-semibold text-rose-700"}`}>
                                                        {r.gst_certificate_on_file
                                                            ? "A GST certificate is on file; a new one is optional."
                                                            : r.application_id
                                                              ? "No GST certificate is on file — choose it to save the GSTIN."
                                                              : "No GST certificate is on file."}
                                                    </span>
                                                    {r.application_id ? (
                                                        <>
                                                            <input
                                                                type="file"
                                                                accept="application/pdf,image/jpeg,image/png,image/webp"
                                                                aria-label="GST certificate"
                                                                onChange={(e) => pickCertificate(r.account_id, e.target.files?.[0] ?? null)}
                                                                className="text-xs text-gray-600"
                                                            />
                                                            <button
                                                                type="button"
                                                                disabled={busy || !certificate}
                                                                onClick={() => uploadCertificate(r.account_id)}
                                                                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-800 disabled:opacity-40"
                                                            >
                                                                {r.gst_certificate_on_file ? "Replace certificate" : "Upload certificate"}
                                                            </button>
                                                        </>
                                                    ) : (
                                                        <span className="text-xs text-gray-400">
                                                            This account has no onboarding application, so a certificate cannot be attached.
                                                        </span>
                                                    )}
                                                </div>
                                                {reading && <p className="mt-2 text-xs text-gray-500">Reading the GSTIN from the file…</p>}
                                                {!reading && certificate && certificateRead && (
                                                    <p className="mt-2 text-xs text-gray-600">
                                                        {!certificateRead.is_gst_certificate && (
                                                            <span className="font-semibold text-amber-700">This does not look like a GST certificate. </span>
                                                        )}
                                                        {certificateRead.gstin ? (
                                                            certificateRead.gstin === gstin ? (
                                                                <>GSTIN read from the file: <span className="font-semibold tabular-nums">{certificateRead.gstin}</span>. Check it, then save.</>
                                                            ) : (
                                                                <>
                                                                    The file shows <span className="font-semibold tabular-nums">{certificateRead.gstin}</span>, which is not what is typed.{" "}
                                                                    <button type="button" className="text-blue-700 underline" onClick={() => setGstin(certificateRead.gstin!)}>
                                                                        Use it
                                                                    </button>
                                                                </>
                                                            )
                                                        ) : (
                                                            "No valid GSTIN could be read from the file — type it."
                                                        )}
                                                    </p>
                                                )}
                                            </td>
                                        </tr>
                                    )}
                                    {historyFor === r.account_id && (
                                        <tr className="bg-gray-50">
                                            <td />
                                            <td colSpan={11} className="px-3 py-3 text-xs text-gray-600">
                                                {gstinCorrected && (
                                                    <p className="mb-1">
                                                        <span className="font-semibold text-gray-800">{gstinCorrected.at}</span> · GSTIN corrected
                                                        {gstinCorrected.by ? ` · by ${gstinCorrected.by}` : ""}
                                                    </p>
                                                )}
                                                {history === null ? (
                                                    "Loading…"
                                                ) : history.length === 0 ? (
                                                    "No owner has been recorded for this account yet."
                                                ) : (
                                                    <ul className="space-y-1">
                                                        {history.map((h) => (
                                                            <li key={h.id}>
                                                                <span className="font-semibold text-gray-800">{h.effective_date}</span> ·{" "}
                                                                {h.from_owner ?? "No owner"} → {h.to_owner ?? "No owner"} · {h.reason}
                                                                {h.changed_by ? ` · by ${h.changed_by}` : ""}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </td>
                                        </tr>
                                    )}
                                </Fragment>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
