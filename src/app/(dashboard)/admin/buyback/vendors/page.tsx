"use client";

/**
 * Scrap vendors (M09 / M18-lite).
 *
 * Deliberately thin. Full vendor onboarding — GST and PAN verification, the
 * Digio agreement, the non-circumvention clause — is M18/M19 in Sprint 4. What
 * exists here is the minimum that makes routing real: an admin can add a vendor
 * they have vetted offline, and that vendor becomes selectable.
 *
 * The list only ever shows ROUTABLE vendors (an ACTIVE SCRAP_VENDOR role). When
 * Sprint 4 makes ACTIVE mean "agreement signed", this screen keeps working and
 * M18's AC — "unonboarded vendor unselectable for routing" — starts holding
 * without a line changing here.
 */

import { useEffect, useState } from "react";

const EMPTY = {
  name: "",
  gstin: "",
  contact_email: "",
  contact_phone: "",
  city: "",
  state: "",
  payment_terms: "",
};

interface Vendor {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  payment_terms: string | null;
}

export default function BuybackVendorsPage() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/admin/buyback/vendors");
      const json = await res.json();
      if (cancelled) return;
      setVendors(json?.data?.vendors ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const submit = async () => {
    setBusy(true);
    setError(null);

    const res = await fetch("/api/admin/buyback/vendors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        contact_phone: form.contact_phone || undefined,
        city: form.city || undefined,
        state: form.state || undefined,
        payment_terms: form.payment_terms || undefined,
        categories: [],
        regions: form.state ? [form.state] : [],
      }),
    });

    const json = await res.json();
    setBusy(false);

    if (!json?.success) {
      setError(json?.error?.message ?? "Could not add the vendor.");
      return;
    }

    setForm(EMPTY);
    setOpen(false);
    setReloadKey((k) => k + 1);
  };

  const field = (key: keyof typeof EMPTY, label: string, placeholder = "") => (
    <label className="block">
      <span className="text-xs font-semibold text-slate-600">{label}</span>
      <input
        value={form[key]}
        placeholder={placeholder}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
      />
    </label>
  );

  return (
    <div className="mx-auto max-w-4xl px-6 pb-24 pt-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-slate-900">Scrap vendors</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Who iTarang can sell collected batteries to.
          </p>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          Add vendor
        </button>
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
        {loading ? (
          <div className="p-10 text-center text-sm text-slate-400">Loading…</div>
        ) : vendors.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-400">
            No vendors yet. A deal cannot be quoted out until there is at least one.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-[10px] font-bold uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2.5">Vendor</th>
                <th className="px-4 py-2.5">Location</th>
                <th className="px-4 py-2.5">Contact</th>
                <th className="px-4 py-2.5">Terms</th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((v) => (
                <tr key={v.id} className="border-t border-slate-50">
                  <td className="px-4 py-2.5 font-semibold text-slate-800">{v.name}</td>
                  <td className="px-4 py-2.5 text-slate-500">
                    {[v.city, v.state].filter(Boolean).join(", ") || "—"}
                  </td>
                  <td className="px-4 py-2.5 text-slate-500">{v.email ?? "—"}</td>
                  <td className="px-4 py-2.5 text-slate-500">{v.payment_terms ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl">
            <div className="text-sm font-bold text-slate-900">Add a scrap vendor</div>
            <p className="mt-1 text-xs text-slate-500">
              A contact email is required — it is where their quotations go.
            </p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">{field("name", "Business name", "AmpFusion Recyclers")}</div>
              {field("gstin", "GSTIN", "27AAAAA0000A1Z5")}
              {field("contact_email", "Contact email", "buy@ampfusion.in")}
              {field("contact_phone", "Contact phone")}
              {field("payment_terms", "Payment terms", "Net 15")}
              {field("city", "City", "Pune")}
              {field("state", "State", "Maharashtra")}
            </div>

            {error && <div className="mt-3 text-xs text-red-600">{error}</div>}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => {
                  setOpen(false);
                  setError(null);
                }}
                className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={
                  busy ||
                  !form.name.trim() ||
                  form.gstin.trim().length !== 15 ||
                  !form.contact_email.trim()
                }
                className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
              >
                {busy ? "Adding…" : "Add vendor"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
