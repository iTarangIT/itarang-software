"use client";

/**
 * Scrap vendors (M09 / M18-lite), restyled onto the shared buyback UI kit
 * (design handoff, iTarang Portal.dc.html `scrVendors`, lines 958-966).
 *
 * Deliberately thin. Full vendor onboarding — GST and PAN verification, the
 * Digio agreement, the non-circumvention clause — is M18/M19 in Sprint 4. What
 * exists here is the minimum that makes routing real: an admin can add a vendor
 * they have vetted offline, and that vendor becomes selectable.
 *
 * The list only ever shows ROUTABLE vendors (an ACTIVE SCRAP_VENDOR role, via
 * `listRoutableVendors`'s own `WHERE sv.active`). When Sprint 4 makes ACTIVE mean
 * "agreement signed", this screen keeps working and M18's AC — "unonboarded
 * vendor unselectable for routing" — starts holding without a line changing here.
 *
 * DATA-BINDING NOTE — the "Active" pill is rendered unconditionally rather than
 * read off an `active` field: `/api/admin/buyback/vendors` (GET) does not expose
 * `active` in its response, and every row it CAN return is already active by
 * construction (the query's own WHERE clause). GSTIN and a "Threads" count are
 * omitted for the same reason — neither is in this endpoint's payload, and this
 * task's endpoints are consumed as-is (no new field, no new endpoint).
 */

import { useEffect, useState } from "react";

import { Card, EmptyState, PageHeader } from "@/components/buyback/ui";

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
  categories: unknown;
  regions: string[];
  payment_terms: string | null;
}

/** ["Li-ion", "Lead-acid"] → "Li-ion, Lead-acid"; empty/missing → "—". */
function listOrDash(value: unknown): string {
  return Array.isArray(value) && value.length > 0 ? value.join(", ") : "—";
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
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader
          title="Vendors"
          sub="Scrap vendors — no login; admin records their responses"
          right={
            <button
              onClick={() => setOpen(true)}
              className="rounded-lg bg-green-600 px-3.5 py-2 text-[12.5px] font-semibold text-white hover:bg-green-700"
            >
              + Add vendor
            </button>
          }
        />

        {error && !open && <p className="mb-4 text-sm text-red-600">{error}</p>}

        {loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : vendors.length === 0 ? (
          <EmptyState
            icon="🏭"
            title="No vendors yet"
            body="A deal cannot be quoted out until there is at least one."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            {vendors.map((v) => (
              <Card key={v.id}>
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-[14.5px] font-bold text-slate-900">{v.name}</div>
                    <span className="inline-flex shrink-0 rounded-full bg-green-100 px-2.5 py-[3px] text-[11px] font-bold text-green-700">
                      Active
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2.5 text-[12.5px]">
                    <div>
                      <div className="text-[11px] font-semibold text-slate-400">Categories</div>
                      <div className="mt-[1px] font-semibold text-slate-700">
                        {listOrDash(v.categories)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold text-slate-400">Regions</div>
                      <div className="mt-[1px] font-semibold text-slate-700">
                        {listOrDash(v.regions)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold text-slate-400">Payment terms</div>
                      <div className="mt-[1px] font-semibold text-slate-700">
                        {v.payment_terms ?? "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold text-slate-400">Contact</div>
                      <div className="mt-[1px] font-semibold text-slate-700">{v.email ?? "—"}</div>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
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
                className="rounded-lg bg-green-600 px-4 py-2 text-xs font-semibold text-white hover:bg-green-700 disabled:bg-slate-200 disabled:text-slate-400"
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
