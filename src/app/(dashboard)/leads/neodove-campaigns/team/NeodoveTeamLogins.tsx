"use client";

// NeoDove → Team logins: list + create + switch off Inside Sales Rep / ASM
// logins (/api/neodove/team-logins). The temporary password is shown once.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

type TeamRole = "inside_sales_rep" | "asm";

interface Login {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    role: TeamRole;
    isActive: boolean;
    createdAt: string;
    mustChangePassword: boolean;
    campaigns: { id: string; name: string }[];
}

const ROLE_LABEL: Record<TeamRole, string> = {
    inside_sales_rep: "Inside Sales Rep",
    asm: "ASM",
};

export default function NeodoveTeamLogins() {
    const [logins, setLogins] = useState<Login[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [phone, setPhone] = useState("");
    const [role, setRole] = useState<TeamRole>("inside_sales_rep");
    const [saving, setSaving] = useState(false);
    const [created, setCreated] = useState<{ email: string; temporaryPassword: string } | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch("/api/neodove/team-logins", { cache: "no-store" });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message || "Could not load the logins");
            setLogins(json.data.logins);
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not load the logins");
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    async function create(e: React.FormEvent) {
        e.preventDefault();
        setSaving(true);
        try {
            const res = await fetch("/api/neodove/team-logins", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, email, phone: phone || undefined, role }),
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message || "Could not create the login");
            setCreated({ email: json.data.email, temporaryPassword: json.data.temporaryPassword });
            setName("");
            setEmail("");
            setPhone("");
            toast.success("Login created");
            await load();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not create the login");
        } finally {
            setSaving(false);
        }
    }

    async function setActive(l: Login, active: boolean) {
        if (!active) {
            const owned = l.campaigns.length
                ? `\n\nThey are the default owner of: ${l.campaigns.map((c) => c.name).join(", ")}. That will be cleared.`
                : "";
            if (!window.confirm(`Switch off ${l.name}? They will no longer be able to sign in.${owned}`)) return;
        }
        const res = await fetch("/api/neodove/team-logins", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: l.id, active }),
        });
        const json = await res.json().catch(() => null);
        if (!json?.success) toast.error(json?.error?.message || "Could not change the login");
        else await load();
    }

    return (
        <div className="space-y-5">
            <form onSubmit={create} className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
                <div className="text-sm font-semibold text-gray-900">Add a team member</div>
                <div className="grid gap-3 md:grid-cols-4">
                    <input className="rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
                    <input className="rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="Email (their sign-in)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                    <input className="rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="Mobile (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} />
                    <select className="rounded-lg border border-gray-300 px-3 py-2 text-sm" value={role} onChange={(e) => setRole(e.target.value as TeamRole)}>
                        <option value="inside_sales_rep">Inside Sales Rep</option>
                        <option value="asm">ASM</option>
                    </select>
                </div>
                <p className="text-xs text-gray-500">
                    The sign-in works on the sandbox and the live CRM alike (one sign-in pool); the person must change the
                    password the first time. An ASM made here has no territory until one is set.
                </p>
                <button type="submit" disabled={saving} className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
                    {saving ? "Creating…" : "Create login"}
                </button>
                {created && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                        Temporary password for <b>{created.email}</b>: <code className="font-mono">{created.temporaryPassword}</code>
                        <span className="block text-xs">Shown once — pass it on to the person now.</span>
                    </div>
                )}
            </form>

            {error && <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
            {logins && (
                <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                    <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                            <tr>
                                <th className="px-4 py-2">Name</th>
                                <th className="px-4 py-2">Role</th>
                                <th className="px-4 py-2">Email</th>
                                <th className="px-4 py-2">Mobile</th>
                                <th className="px-4 py-2">Since</th>
                                <th className="px-4 py-2">Status</th>
                                <th className="px-4 py-2" />
                            </tr>
                        </thead>
                        <tbody>
                            {logins.length === 0 && (
                                <tr>
                                    <td colSpan={7} className="px-4 py-6 text-center text-gray-500">
                                        No Inside Sales Rep or ASM logins yet.
                                    </td>
                                </tr>
                            )}
                            {logins.map((l) => (
                                <tr key={l.id} className={`border-t border-gray-100 ${l.isActive ? "" : "text-gray-400"}`}>
                                    <td className="px-4 py-2">
                                        {l.name}
                                        {l.mustChangePassword && l.isActive && (
                                            <span className="ml-2 rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-700">not signed in yet</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-2">{ROLE_LABEL[l.role] ?? l.role}</td>
                                    <td className="px-4 py-2">{l.email}</td>
                                    <td className="px-4 py-2">{l.phone ?? "—"}</td>
                                    <td className="px-4 py-2">{l.createdAt ? new Date(l.createdAt).toLocaleDateString("en-IN") : "—"}</td>
                                    <td className="px-4 py-2">{l.isActive ? "Active" : "Off"}</td>
                                    <td className="px-4 py-2 text-right">
                                        <button
                                            type="button"
                                            className={`text-xs font-medium ${l.isActive ? "text-rose-600" : "text-gray-700"}`}
                                            onClick={() => setActive(l, !l.isActive)}
                                        >
                                            {l.isActive ? "Switch off" : "Switch on"}
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
