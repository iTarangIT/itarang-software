"use client";

// 23 Nov — Settings › Dealer check alerts (/api/admin/settings/dealer-check).

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

type Recipient = {
  userId: string;
  name: string;
  email: string | null;
  whatsapp: string | null;
  emailOn: boolean;
  whatsappOn: boolean;
};
type SendResult = { ok: boolean; error: string | null };
type Person = { id: string; name: string; email: string | null; phone: string | null; role: string | null };

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  sales_head: "Sales Head",
  ceo: "CEO",
  partner: "Partner",
  business_head: "Business Head",
};

export default function DealerCheckAlertsForm() {
  const [rows, setRows] = useState<Recipient[] | null>(null);
  const [team, setTeam] = useState<Person[]>([]);
  const [adding, setAdding] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/settings/dealer-check", { cache: "no-store" });
    const j = await res.json().catch(() => null);
    if (!j?.success) return toast.error(j?.error?.message || "Could not load the alert list");
    setRows(j.data.recipients);
    setTeam(j.data.team);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  function add() {
    const p = team.find((t) => t.id === adding);
    if (!p || !rows) return;
    const mobile = (p.phone ?? "").replace(/\D/g, "").slice(-10);
    setRows([
      ...rows,
      {
        userId: p.id,
        name: p.name,
        email: p.email,
        whatsapp: mobile.length === 10 ? mobile : null,
        emailOn: !!p.email,
        whatsappOn: mobile.length === 10,
      },
    ]);
    setAdding("");
  }

  function patch(i: number, change: Partial<Recipient>) {
    setRows((cur) => (cur ? cur.map((r, j) => (j === i ? { ...r, ...change } : r)) : cur));
  }

  // "Send test" — one sample alert to this row, as typed (works before Save).
  const [testing, setTesting] = useState<string | null>(null);
  async function sendTest(r: Recipient) {
    setTesting(r.userId);
    try {
      const res = await fetch("/api/admin/settings/dealer-check/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(r),
      });
      const j = await res.json().catch(() => null);
      if (!j?.success) throw new Error(j?.error?.message || "Could not send the test");
      const d = j.data as { email: SendResult | null; whatsapp: SendResult | null };
      const parts: string[] = [];
      let allOk = true;
      if (d.email) {
        parts.push(d.email.ok ? `Email sent to ${r.email}` : `Email failed: ${d.email.error}`);
        allOk &&= d.email.ok;
      }
      if (d.whatsapp) {
        parts.push(
          d.whatsapp.ok
            ? `WhatsApp sent to ${r.whatsapp}`
            : `WhatsApp not delivered (${d.whatsapp.error}) — the number must have messaged the iTarang WhatsApp in the last 24 hours`,
        );
        allOk &&= d.whatsapp.ok;
      }
      (allOk ? toast.success : toast.error)(`Test to ${r.name}: ${parts.join(" · ")}`, { duration: 8000 });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the test");
    } finally {
      setTesting(null);
    }
  }

  async function save() {
    if (!rows) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings/dealer-check", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipients: rows }),
      });
      const j = await res.json().catch(() => null);
      if (!j?.success) throw new Error(j?.error?.message || "Could not save");
      toast.success("Saved — the next dealer check goes to this list");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  if (!rows) return <p className="text-sm text-gray-500">Loading…</p>;
  const roleOf = (id: string) => team.find((t) => t.id === id)?.role ?? null;
  const available = team.filter((t) => !rows.some((r) => r.userId === t.id));

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">WhatsApp mobile</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-gray-500">
                  Nobody yet — add Chirag, Anirudh, the Admin and Sanchit below.
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.userId}>
                <td className="px-3 py-2">
                  <input value={r.name} onChange={(e) => patch(i, { name: e.target.value })}
                    className="w-40 rounded border border-gray-300 px-2 py-1" />
                  <span className="block text-[11px] text-gray-500">{ROLE_LABEL[roleOf(r.userId) ?? ""] ?? roleOf(r.userId) ?? ""}</span>
                </td>
                <td className="px-3 py-2">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={r.emailOn} onChange={(e) => patch(i, { emailOn: e.target.checked })} />
                    <input value={r.email ?? ""} onChange={(e) => patch(i, { email: e.target.value })} placeholder="name@itarang.com"
                      className="w-56 rounded border border-gray-300 px-2 py-1" />
                  </label>
                </td>
                <td className="px-3 py-2">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={r.whatsappOn} onChange={(e) => patch(i, { whatsappOn: e.target.checked })} />
                    <input value={r.whatsapp ?? ""} onChange={(e) => patch(i, { whatsapp: e.target.value })} placeholder="10-digit mobile"
                      className="w-36 rounded border border-gray-300 px-2 py-1" />
                  </label>
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button type="button" disabled={testing !== null || (!(r.emailOn && r.email) && !(r.whatsappOn && r.whatsapp))}
                    onClick={() => sendTest(r)}
                    title="Send this person a sample dealer-check alert by the ticked channels"
                    className="mr-3 rounded border border-[#0047AB] px-2 py-1 text-xs font-semibold text-[#0047AB] disabled:opacity-40">
                    {testing === r.userId ? "Sending…" : "Send test"}
                  </button>
                  <button type="button" className="text-xs font-semibold text-red-600"
                    onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select value={adding} onChange={(e) => setAdding(e.target.value)} className="rounded border border-gray-300 px-2 py-1.5 text-sm">
          <option value="">Add a team member…</option>
          {available.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} {t.role ? `(${ROLE_LABEL[t.role] ?? t.role})` : ""}
            </option>
          ))}
        </select>
        <button type="button" disabled={!adding} onClick={add}
          className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50">
          Add
        </button>
        <button type="button" disabled={saving} onClick={save}
          className="ml-auto rounded bg-[#0047AB] px-4 py-1.5 text-sm font-bold text-white disabled:opacity-50">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="text-xs text-gray-500">
        WhatsApp reaches a number only while it has chatted with the iTarang WhatsApp number in the last 24 hours, until
        Meta approves the &ldquo;lead action&rdquo; template. Email always goes.
      </p>
    </div>
  );
}
