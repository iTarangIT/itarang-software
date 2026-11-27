"use client";

// ID 182: list + create + switch off the per-person house team logins
// (/api/admin/house-team-logins).
// 27 Nov: the "Sales person" link column is gone (one login ID per person);
// a login ID already on the CRM is refused with the role that holds it; the
// new login ID + temporary password are shown (and emailed); the Sales Head
// can change a login's password.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, KeyRound, X } from "lucide-react";

interface Login {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
  mustChangePassword: boolean;
  shared: boolean;
  /** 23 Nov — may approve / change / reject dealer checks (always true for the shared login). */
  canApprove: boolean;
}

type Credentials = { title: string; email: string; temporaryPassword: string; emailed: boolean };

function CredentialsBox({ c, onClose }: { c: Credentials; onClose: () => void }) {
  const copy = () => {
    void navigator.clipboard?.writeText(`Login ID: ${c.email}\nTemporary password: ${c.temporaryPassword}`);
    toast.success("Copied");
  };
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
      <div className="flex items-start justify-between gap-3">
        <p className="font-semibold">{c.title}</p>
        <button type="button" onClick={onClose} className="text-emerald-700 hover:text-emerald-900" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>
      <dl className="mt-2 grid gap-1 font-mono text-[13px] sm:grid-cols-[10rem_1fr]">
        <dt className="text-emerald-700">Login ID</dt>
        <dd className="font-semibold">{c.email}</dd>
        <dt className="text-emerald-700">Temporary password</dt>
        <dd className="font-semibold">{c.temporaryPassword}</dd>
      </dl>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
        <button type="button" onClick={copy} className="inline-flex items-center gap-1 font-semibold text-emerald-800 hover:underline">
          <Copy className="h-3.5 w-3.5" /> Copy both
        </button>
        <span>
          {c.emailed
            ? "Also emailed to the person. They must set their own password when they sign in."
            : "The email could NOT be sent — pass these on to the person yourself."}
        </span>
      </div>
    </div>
  );
}

export default function HouseTeamLogins() {
  const [logins, setLogins] = useState<Login[] | null>(null);
  const [houseCode, setHouseCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [emailTaken, setEmailTaken] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  // Change-password dialog.
  const [pwFor, setPwFor] = useState<Login | null>(null);
  const [newPw, setNewPw] = useState("");
  const [pwSaving, setPwSaving] = useState(false);

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

  // Live "is this login ID free?" check, a moment after typing stops.
  useEffect(() => {
    const v = email.trim().toLowerCase();
    setEmailTaken(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/house-team-logins?checkEmail=${encodeURIComponent(v)}`, { cache: "no-store" });
        const json = await res.json();
        if (json.success && json.data.email === v) setEmailTaken(json.data.taken ? json.data.message : null);
      } catch {
        /* the create call checks again */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [email]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (emailTaken) {
      toast.error(emailTaken);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/house-team-logins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone: phone || undefined }),
      });
      const json = await res.json();
      if (!json.success) {
        const msg = json.error?.message || "Could not create the login";
        if (/login ID/i.test(msg)) setEmailTaken(msg);
        throw new Error(msg);
      }
      setCredentials({
        title: `Login created for ${json.data.name}`,
        email: json.data.email,
        temporaryPassword: json.data.temporaryPassword,
        emailed: !!json.data.emailed,
      });
      setName("");
      setEmail("");
      setPhone("");
      toast.success("Login created — welcome email sent");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the login");
    } finally {
      setSaving(false);
    }
  }

  async function patch(body: Record<string, unknown>) {
    const res = await fetch("/api/admin/house-team-logins", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json().catch(() => null)) as
      | { success: boolean; data?: { email?: string; temporaryPassword?: string; emailed?: boolean }; error?: { message?: string } }
      | null;
  }

  async function setActive(l: Login, active: boolean) {
    const json = await patch({ userId: l.id, active });
    if (!json?.success) toast.error(json?.error?.message || "Could not change the login");
    else await load();
  }

  async function setCanApprove(l: Login, canApprove: boolean) {
    const json = await patch({ userId: l.id, canApprove });
    if (!json?.success) toast.error(json?.error?.message || "Could not change the approval right");
    else {
      toast.success(canApprove ? `${l.name} can now approve dealer checks` : `${l.name} can no longer approve`);
      await load();
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!pwFor) return;
    setPwSaving(true);
    try {
      const json = await patch({ userId: pwFor.id, resetPassword: true, password: newPw.trim() || undefined });
      if (!json?.success || !json.data?.temporaryPassword) {
        throw new Error(json?.error?.message || "Could not change the password");
      }
      setCredentials({
        title: `New password set for ${pwFor.name}`,
        email: json.data.email ?? pwFor.email,
        temporaryPassword: json.data.temporaryPassword,
        emailed: !!json.data.emailed,
      });
      toast.success("Password changed");
      setPwFor(null);
      setNewPw("");
      await load();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change the password");
    } finally {
      setPwSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      {credentials && <CredentialsBox c={credentials} onClose={() => setCredentials(null)} />}

      <form onSubmit={create} className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
        <div className="text-sm font-semibold text-gray-900">Add a team member</div>
        <div className="grid gap-3 md:grid-cols-3">
          <input className="rounded border border-gray-300 px-3 py-2 text-sm" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <div>
            <input
              className={`w-full rounded border px-3 py-2 text-sm ${emailTaken ? "border-red-400 bg-red-50" : "border-gray-300"}`}
              placeholder="Email (their login ID)"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            {emailTaken && <p className="mt-1 text-xs font-medium text-red-700">{emailTaken}</p>}
          </div>
          <input className="rounded border border-gray-300 px-3 py-2 text-sm" placeholder="Mobile (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <p className="text-xs text-gray-500">
          The login is created under the house dealer code {houseCode ?? "…"}. Each person needs their own login ID — an
          email already used on the CRM is refused. The person gets a welcome email with their login ID and temporary
          password (also shown here), and must set their own password the first time they sign in. Every step a login
          takes on a file is recorded under that person&rsquo;s name. Tick &ldquo;Can approve&rdquo; for the people
          allowed to approve, change or reject a dealer at the dealer check.
        </p>
        <button
          type="submit"
          disabled={saving || !!emailTaken}
          className="rounded-lg bg-[#0047AB] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {saving ? "Creating…" : "Create login"}
        </button>
      </form>

      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {logins && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Login ID</th>
                <th className="px-4 py-2">Mobile</th>
                <th className="px-4 py-2" title="May approve, change or reject a dealer at the dealer check">Can approve</th>
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
                  <td className="px-4 py-2">
                    {l.email}
                    {l.mustChangePassword && !l.shared && (
                      <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700">temporary password</span>
                    )}
                  </td>
                  <td className="px-4 py-2">{l.phone ?? "—"}</td>
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      checked={l.canApprove}
                      disabled={l.shared || !l.isActive}
                      title={l.shared ? "The shared house login always approves" : "Approve / change / reject dealer checks"}
                      onChange={(e) => void setCanApprove(l, e.target.checked)}
                    />
                  </td>
                  <td className="px-4 py-2">{new Date(l.createdAt).toLocaleDateString("en-IN")}</td>
                  <td className="px-4 py-2">{l.isActive ? "Active" : "Off"}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    {!l.shared && (
                      <>
                        <button
                          type="button"
                          className="mr-4 inline-flex items-center gap-1 text-xs font-medium text-[#0047AB]"
                          onClick={() => {
                            setPwFor(l);
                            setNewPw("");
                          }}
                        >
                          <KeyRound className="h-3.5 w-3.5" /> Change password
                        </button>
                        <button type="button" className="text-xs font-medium text-[#0047AB]" onClick={() => setActive(l, !l.isActive)}>
                          {l.isActive ? "Switch off" : "Switch on"}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pwFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !pwSaving && setPwFor(null)}>
          <form
            onSubmit={changePassword}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md space-y-3 rounded-xl bg-white p-5 shadow-xl"
          >
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-semibold text-gray-900">Change password</h3>
                <p className="text-xs text-gray-500">
                  {pwFor.name} · {pwFor.email}
                </p>
              </div>
              <button type="button" onClick={() => setPwFor(null)} disabled={pwSaving} aria-label="Close">
                <X className="h-4 w-4 text-gray-500" />
              </button>
            </div>
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-gray-600">New password (leave blank to generate one)</span>
              <input
                type="text"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                placeholder="e.g. Itarang2026"
                autoComplete="off"
                className="w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm"
              />
            </label>
            <p className="text-xs text-gray-500">
              At least 8 characters with a letter and a number. The new password is emailed to the person and shown here;
              they must set their own when they next sign in. Their current password stops working immediately.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setPwFor(null)} disabled={pwSaving} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">
                Cancel
              </button>
              <button type="submit" disabled={pwSaving} className="rounded-lg bg-[#0047AB] px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
                {pwSaving ? "Saving…" : "Change password"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
