"use client";

// E-307 — EPC agents (Ecofy's EPC partner master) for Sales Head, ASM and ISR:
// the list, and a form to add one. Editing stays in Ecofy's own Admin screen.

import Link from "next/link";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ecofyGet, type EpcPartner } from "./client";
import { EpcPartnerForm } from "./EpcPartnerPicker";
import { Btn, Chip, Empty, ErrorNote, Loading } from "./ui";

export function EcofyEpcAgentsPage({ backHref }: { backHref?: { href: string; label: string } }) {
    const qc = useQueryClient();
    const q = useQuery({
        queryKey: ["ecofy-epc-partners"],
        queryFn: () => ecofyGet<EpcPartner[]>("/api/ecofy/epc-partners"),
    });
    const [adding, setAdding] = useState(false);
    const [flash, setFlash] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const needle = search.trim().toLowerCase();
    const rows = (q.data ?? []).filter(
        (p) =>
            !needle ||
            p.name.toLowerCase().includes(needle) ||
            (p.contactName ?? "").toLowerCase().includes(needle) ||
            (p.pincodes ?? []).some((pc) => pc.includes(needle)),
    );

    return (
        <div className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 md:px-8">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Ecofy — EPC agents</h1>
                    <p className="mt-1 text-sm text-gray-600">
                        The installers you can book site visits with, request quotes from and hand installations to. Agents added
                        here go straight into Ecofy&apos;s EPC partner master and appear in every picker.
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    {backHref && (
                        <Link href={backHref.href} className="text-sm text-blue-700 hover:underline">
                            ← {backHref.label}
                        </Link>
                    )}
                    <Btn variant="primary" onClick={() => setAdding((a) => !a)}>
                        {adding ? "Close" : "+ New EPC agent"}
                    </Btn>
                </div>
            </header>

            {adding && (
                <EpcPartnerForm
                    onCancel={() => setAdding(false)}
                    onCreated={(p) => {
                        setAdding(false);
                        setFlash(`${p.name} added.`);
                        void qc.invalidateQueries({ queryKey: ["ecofy-epc-partners"] });
                    }}
                />
            )}
            {flash && (
                <p className="rounded-lg border border-emerald-100 bg-emerald-50 p-3 text-sm text-emerald-900">
                    {flash}{" "}
                    <button type="button" className="text-xs underline" onClick={() => setFlash(null)}>
                        dismiss
                    </button>
                </p>
            )}

            <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
                    <h2 className="text-sm font-semibold text-gray-900">
                        EPC agents {q.data ? <span className="font-normal text-gray-500">· {rows.length}</span> : null}
                    </h2>
                    <input
                        className="w-full max-w-xs rounded-md border border-gray-300 px-2.5 py-1.5 text-sm"
                        placeholder="Search shop, agent or pincode…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </header>
                <div className="p-4">
                    {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : null}
                    {q.data && rows.length === 0 && (
                        <Empty>{needle ? "No EPC agent matches." : "No EPC agents yet — add the first one."}</Empty>
                    )}
                    {rows.length > 0 && (
                        <div className="overflow-x-auto">
                            <table className="min-w-full text-sm">
                                <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                                    <tr>
                                        <th className="py-2 pr-4">Shop / name</th>
                                        <th className="py-2 pr-4">Agent</th>
                                        <th className="py-2 pr-4">Phone</th>
                                        <th className="py-2 pr-4">Pincodes</th>
                                        <th className="py-2 pr-4">Status</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                    {rows.map((p) => {
                                        const pins = p.pincodes ?? [];
                                        return (
                                            <tr key={p.id} className={p.active ? "" : "text-gray-400"}>
                                                <td className="py-2 pr-4 font-medium text-gray-900">{p.name}</td>
                                                <td className="py-2 pr-4">{p.contactName || "—"}</td>
                                                <td className="py-2 pr-4">{p.mobile || "—"}</td>
                                                <td className="max-w-xs truncate py-2 pr-4" title={pins.join(", ")}>
                                                    {pins.slice(0, 6).join(", ")}
                                                    {pins.length > 6 ? ` +${pins.length - 6}` : ""}
                                                </td>
                                                <td className="py-2 pr-4">
                                                    <Chip tone={p.active ? "green" : "gray"}>{p.active ? "active" : "inactive"}</Chip>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}
