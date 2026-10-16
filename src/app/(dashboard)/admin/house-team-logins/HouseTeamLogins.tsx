"use client";

// ID 182: list + create + switch off the per-person house team logins
// (/api/admin/house-team-logins). The temporary password is shown once.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface Login {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
  mustChangePassword: boolean;
  shared: boolean;
}

export default function HouseTeamLogins() {
  const [logins, setLogins] = useState<Login[] | null>(null);
  const [houseCode, setHouseCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<{ email: string; temporaryPassword: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/house-team-logins", { cache: "no-store" });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || "Could not load the logins");
      setLogins(json.data.logins);
      setHouseCode(json.data.houseDealerCode);
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
      const res = await fetch("/api/admin/house-team-logins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone: phone || undefined }),
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
    const res = await fetch("/api/admin/house-team-logins", {
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
      <form onSubmit={create} className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
        <div className="text-sm font-semibold text-gray-900">Add a team member</div>
        <div className="grid gap-3 md:grid-cols-3">
          <input className="rounded border border-gray-300 px-3 py-2 text-sm" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <input className="rounded border border-gray-300 px-3 py-2 text-sm" placeholder="Email (their sign-in)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input className="rounded border border-gray-300 px-3 py-2 text-sm" placeholder="Mobile (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <p className="text-xs text-gray-500">
          The login is created under the house dealer code {houseCode ?? "…"}. The sign-in works on the sandbox and the live
          CRM alike (one sign-in pool); the team member must change the password the first time.
        </p>
        <button type="submit" disabled={saving} className="rounded-lg bg-[#0047AB] px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
          {saving ? "Creating…" : "Create login"}
        </button>
        {created && (
          <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            Temporary password for <b>{created.email}</b>: <code className="font-mono">{created.temporaryPassword}</code>
            <span className="block text-xs">Shown once — pass it on to the person now.</span>
          </div>
        )}
      </form>

      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {logins && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Mobile</th>
                <th className="px-4 py-2">Since</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {logins.map((l) => (
                <tr key={l.id} className="border-t border-gray-100">
                  <td className="px-4 py-2">
                    {l.name}
                    {l.shared && <span className="ml-2 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">shared house login</span>}
                  </td>
                  <td className="px-4 py-2">{l.email}</td>
                  <td className="px-4 py-2">{l.phone ?? "—"}</td>
                  <td className="px-4 py-2">{new Date(l.createdAt).toLocaleDateString("en-IN")}</td>
                  <td className="px-4 py-2">{l.isActive ? "Active" : "Off"}</td>
                  <td className="px-4 py-2 text-right">
                    {!l.shared && (
                      <button type="button" className="text-xs font-medium text-[#0047AB]" onClick={() => setActive(l, !l.isActive)}>
                        {l.isActive ? "Switch off" : "Switch on"}
                      </button>
                    )}
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
