"use client";

import { useState } from "react";
import { Loader2, Save, CheckCircle2 } from "lucide-react";
import { inputCls, paiseToRupees, rupeesToPaise, postJson } from "./helpers";

interface SettingsRow {
  dealerMarginPaise: number;
  nearBestWindowPct: string;
  expectedEmiFilterRequired: boolean;
  upfrontFilterRequired: boolean;
  disclaimerText: string;
  cardFooterDisclaimer: string;
  contactPhone: string;
  contactEmail: string;
  contactWhatsapp: string;
}

export function SettingsClient({ initial }: { initial: SettingsRow | null }) {
  const [f, setF] = useState({
    dealerMargin: initial ? String(paiseToRupees(initial.dealerMarginPaise)) : "6000",
    nearBestWindowPct: initial?.nearBestWindowPct ?? "25",
    expectedEmiFilterRequired: initial?.expectedEmiFilterRequired ?? false,
    upfrontFilterRequired: initial?.upfrontFilterRequired ?? false,
    disclaimerText: initial?.disclaimerText ?? "",
    cardFooterDisclaimer: initial?.cardFooterDisclaimer ?? "",
    contactPhone: initial?.contactPhone ?? "",
    contactEmail: initial?.contactEmail ?? "",
    contactWhatsapp: initial?.contactWhatsapp ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof f, v: string | boolean) => {
    setF((s) => ({ ...s, [k]: v }));
    setSaved(false);
  };

  async function save() {
    if (!initial) {
      setError("No settings row exists yet — run the seed first.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await postJson("/api/admin/calculator/settings", {
        dealerMarginPaise: rupeesToPaise(Number(f.dealerMargin)),
        nearBestWindowPct: f.nearBestWindowPct,
        expectedEmiFilterRequired: f.expectedEmiFilterRequired,
        upfrontFilterRequired: f.upfrontFilterRequired,
        disclaimerText: f.disclaimerText,
        cardFooterDisclaimer: f.cardFooterDisclaimer,
        contactPhone: f.contactPhone,
        contactEmail: f.contactEmail,
        contactWhatsapp: f.contactWhatsapp,
      });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <Section title="Pricing & filters">
        <div className="grid grid-cols-2 gap-4">
          <L label="Dealer margin (₹, GST-incl)">
            <input className={inputCls} type="number" value={f.dealerMargin} onChange={(e) => set("dealerMargin", e.target.value)} />
          </L>
          <L label="Near-best window (%)">
            <input className={inputCls} type="number" value={f.nearBestWindowPct} onChange={(e) => set("nearBestWindowPct", e.target.value)} />
          </L>
        </div>
        <div className="mt-3 flex flex-col gap-2">
          <Check label="Expected-EMI filter mandatory on Card 1" checked={f.expectedEmiFilterRequired} onChange={(v) => set("expectedEmiFilterRequired", v)} />
          <Check label="Upfront-ability filter mandatory on Card 1" checked={f.upfrontFilterRequired} onChange={(v) => set("upfrontFilterRequired", v)} />
        </div>
      </Section>

      <Section title="Disclaimers">
        <L label="Per-card indicative disclaimer">
          <textarea className={inputCls} rows={2} value={f.disclaimerText} onChange={(e) => set("disclaimerText", e.target.value)} />
        </L>
        <L label="Card-2 footer disclaimer">
          <textarea className={inputCls} rows={2} value={f.cardFooterDisclaimer} onChange={(e) => set("cardFooterDisclaimer", e.target.value)} />
        </L>
      </Section>

      <Section title="Footer contact">
        <div className="grid grid-cols-3 gap-4">
          <L label="Phone"><input className={inputCls} value={f.contactPhone} onChange={(e) => set("contactPhone", e.target.value)} /></L>
          <L label="Email"><input className={inputCls} value={f.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} /></L>
          <L label="WhatsApp"><input className={inputCls} value={f.contactWhatsapp} onChange={(e) => set("contactWhatsapp", e.target.value)} /></L>
        </div>
      </Section>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        onClick={save}
        disabled={saving}
        className="inline-flex items-center gap-2 rounded-xl bg-gray-900 px-5 py-2.5 text-sm font-bold text-white hover:bg-gray-800 disabled:opacity-50"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <CheckCircle2 className="h-4 w-4" /> : <Save className="h-4 w-4" />}
        {saving ? "Saving…" : saved ? "Saved" : "Save settings"}
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-sm font-bold text-gray-900">{title}</h3>
      {children}
    </div>
  );
}
function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      {children}
    </label>
  );
}
function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-gray-700">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-gray-300" />
      {label}
    </label>
  );
}
