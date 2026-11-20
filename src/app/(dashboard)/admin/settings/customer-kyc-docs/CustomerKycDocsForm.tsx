"use client";

// E-392 — Settings › Customer KYC documents (/api/admin/settings/customer-kyc-docs).

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

type Doc = { key: string; label: string; mandatory: boolean; whatsapp: boolean; asked: boolean };

export default function CustomerKycDocsForm() {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/settings/customer-kyc-docs", { cache: "no-store" });
    const j = await res.json().catch(() => null);
    if (j?.success) setDocs(j.data.catalogue);
    else toast.error(j?.error?.message || "Could not load the document list");
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!docs) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings/customer-kyc-docs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: docs.filter((d) => !d.mandatory && d.asked).map((d) => d.key) }),
      });
      const j = await res.json().catch(() => null);
      if (!j?.success) throw new Error(j?.error?.message || "Could not save");
      toast.success("Saved — new applications use this list");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  if (!docs) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white divide-y divide-gray-100">
        {docs.map((d) => (
          <label key={d.key} className={`flex items-center justify-between gap-3 px-4 py-3 ${d.mandatory ? "bg-gray-50" : "cursor-pointer"}`}>
            <span>
              <span className="text-sm font-semibold text-gray-900">{d.label}</span>
              <span className="block text-xs text-gray-500">
                {d.mandatory
                  ? "Always asked — can't be skipped"
                  : d.whatsapp
                    ? "Asked on WhatsApp and the CRM — can be skipped with a reason"
                    : "CRM only (the WhatsApp reader can't recognise it) — on WhatsApp it can be skipped or added on the portal"}
              </span>
            </span>
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={d.asked}
              disabled={d.mandatory}
              onChange={(e) => setDocs((cur) => cur?.map((x) => (x.key === d.key ? { ...x, asked: e.target.checked } : x)) ?? null)}
            />
          </label>
        ))}
        <div className="flex items-center justify-between gap-3 bg-gray-50 px-4 py-3">
          <span>
            <span className="text-sm font-semibold text-gray-900">Mobile number</span>
            <span className="block text-xs text-gray-500">Always asked at Step 1 — can&apos;t be skipped</span>
          </span>
          <input type="checkbox" className="h-5 w-5" checked disabled readOnly />
        </div>
      </div>
      <button type="button" disabled={saving} onClick={() => void save()} className="rounded-lg bg-[#0047AB] px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
