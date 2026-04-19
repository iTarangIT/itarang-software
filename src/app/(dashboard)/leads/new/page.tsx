"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  Loader2,
  User,
  Phone,
  Store,
  MapPin,
  Globe,
  Tag,
  CheckCircle2,
  AlertCircle,
  Sparkles,
} from "lucide-react";
import Link from "next/link";

// ─── Constants ────────────────────────────────────────────────

const LANGUAGES = [
  { label: "Hindi",     value: "hindi" },
  { label: "English",   value: "english" },
  { label: "Hinglish",  value: "hinglish" },
  { label: "Marathi",   value: "marathi" },
  { label: "Gujarati",  value: "gujarati" },
  { label: "Punjabi",   value: "punjabi" },
  { label: "Telugu",    value: "telugu" },
  { label: "Tamil",     value: "tamil" },
];

const STATUSES: {
  value: string;
  label: string;
  color: string;
  ring: string;
  dot: string;
}[] = [
  { value: "new",          label: "New",          color: "bg-gray-100 text-gray-700",     ring: "ring-gray-300",   dot: "bg-gray-400" },
  { value: "cold",         label: "Cold",         color: "bg-blue-50 text-blue-700",      ring: "ring-blue-400",   dot: "bg-blue-400" },
  { value: "warm",         label: "Warm",         color: "bg-amber-50 text-amber-700",    ring: "ring-amber-400",  dot: "bg-amber-400" },
  { value: "hot",          label: "Hot",          color: "bg-red-50 text-red-700",        ring: "ring-red-400",    dot: "bg-red-500" },
  { value: "contacted",    label: "Contacted",    color: "bg-purple-50 text-purple-700",  ring: "ring-purple-400", dot: "bg-purple-500" },
  { value: "interested",   label: "Interested",   color: "bg-emerald-50 text-emerald-700",ring: "ring-emerald-400",dot: "bg-emerald-500" },
  { value: "disqualified", label: "Disqualified", color: "bg-zinc-100 text-zinc-600",     ring: "ring-zinc-400",   dot: "bg-zinc-400" },
  { value: "stop",         label: "Stop",         color: "bg-red-100 text-red-800",       ring: "ring-red-600",    dot: "bg-red-600" },
];

// ─── Main Page ────────────────────────────────────────────────

export default function NewDealerLeadPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState("");

  const [form, setForm] = useState({
    dealer_name: "",
    phone: "",
    shop_name: "",
    location: "",
    language: "hinglish",
    current_status: "new",
  });

  const update = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => { const n = { ...prev }; delete n[field]; return n; });
    setApiError("");
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.dealer_name.trim())
      e.dealer_name = "Dealer name is required";
    if (!form.phone.trim())
      e.phone = "Phone number is required";
    else if (!/^\+?[0-9]{10,13}$/.test(form.phone.replace(/[\s-]/g, "")))
      e.phone = "Enter a valid 10–13 digit phone number";
    if (!form.location.trim())
      e.location = "Location is required";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setLoading(true);
    setApiError("");
    try {
      const res = await fetch("/api/dealer-leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dealer_name: form.dealer_name.trim(),
          phone: form.phone.trim(),
          shop_name: form.shop_name.trim() || null,
          location: form.location.trim(),
          language: form.language,
          current_status: form.current_status,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSuccess(true);
        setTimeout(() => router.push("/leads"), 1200);
      } else {
        // Handle duplicate phone nicely
        if (data.error?.includes("unique") || data.error?.includes("duplicate")) {
          setErrors({ phone: "This phone number already exists in your leads" });
        } else {
          setApiError(data.error || "Failed to create lead. Please try again.");
        }
      }
    } catch {
      setApiError("Network error. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  // ── Success flash ──────────────────────────────────────────
  if (success) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 bg-emerald-50 rounded-2xl flex items-center justify-center mx-auto mb-4 animate-bounce-once">
            <CheckCircle2 className="w-8 h-8 text-emerald-500" />
          </div>
          <p className="text-base font-semibold text-gray-900">Lead Created!</p>
          <p className="text-sm text-gray-500 mt-1">Redirecting to leads…</p>
        </div>
      </div>
    );
  }

  const selectedStatus = STATUSES.find((s) => s.value === form.current_status);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">

        {/* ── HEADER ─────────────────────────────────────────── */}
        <div className="flex items-center gap-3 mb-8">
          <Link
            href="/leads"
            className="p-2 hover:bg-white rounded-xl border border-transparent hover:border-gray-200 transition-all"
          >
            <ChevronLeft className="w-5 h-5 text-gray-600" />
          </Link>
          <div>
            <h1 className="text-xl font-bold text-gray-900 tracking-tight">New Dealer Lead</h1>
            <p className="text-sm text-gray-500 mt-0.5">Add a dealer to your outreach pipeline</p>
          </div>
        </div>

        {/* ── API ERROR ───────────────────────────────────────── */}
        {apiError && (
          <div className="mb-5 flex items-start gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-xl">
            <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
            <p className="text-sm text-red-600">{apiError}</p>
          </div>
        )}

        <div className="space-y-4">

          {/* ── SECTION 1: Dealer Info ─────────────────────────── */}
          <Section
            icon={<User className="w-3.5 h-3.5 text-white" />}
            title="Dealer Information"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Dealer Name" required error={errors.dealer_name} className="sm:col-span-2">
                <InputWithIcon icon={<User className="w-4 h-4" />} error={!!errors.dealer_name}>
                  <input
                    type="text"
                    value={form.dealer_name}
                    onChange={(e) => update("dealer_name", e.target.value)}
                    placeholder="e.g. Ramesh Kumar"
                    className={inputCls(!!errors.dealer_name)}
                    autoComplete="off"
                  />
                </InputWithIcon>
              </Field>

              <Field label="Phone Number" required error={errors.phone} className="sm:col-span-2">
                <InputWithIcon icon={<Phone className="w-4 h-4" />} error={!!errors.phone}>
                  <input
                    type="tel"
                    value={form.phone}
                    onChange={(e) => update("phone", e.target.value)}
                    placeholder="+919876543210"
                    className={inputCls(!!errors.phone)}
                    autoComplete="off"
                  />
                </InputWithIcon>
                <p className="text-xs text-gray-400 mt-1.5 ml-0.5">
                  Include country code, e.g. +91XXXXXXXXXX
                </p>
              </Field>
            </div>
          </Section>

          {/* ── SECTION 2: Shop Info ───────────────────────────── */}
          <Section
            icon={<Store className="w-3.5 h-3.5 text-white" />}
            title="Shop Information"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Shop Name" hint="Optional" className="sm:col-span-2">
                <InputWithIcon icon={<Store className="w-4 h-4" />}>
                  <input
                    type="text"
                    value={form.shop_name}
                    onChange={(e) => update("shop_name", e.target.value)}
                    placeholder="e.g. Ramesh Battery Shop"
                    className={inputCls()}
                    autoComplete="off"
                  />
                </InputWithIcon>
              </Field>

              <Field label="Location / City" required error={errors.location} className="sm:col-span-2">
                <InputWithIcon icon={<MapPin className="w-4 h-4" />} error={!!errors.location}>
                  <input
                    type="text"
                    value={form.location}
                    onChange={(e) => update("location", e.target.value)}
                    placeholder="e.g. Nashik, Maharashtra"
                    className={inputCls(!!errors.location)}
                    autoComplete="off"
                  />
                </InputWithIcon>
              </Field>
            </div>
          </Section>

          {/* ── SECTION 3: Lead Settings ───────────────────────── */}
          <Section
            icon={<Tag className="w-3.5 h-3.5 text-white" />}
            title="Lead Settings"
          >
            <div className="space-y-6">

              {/* Language */}
              <div>
                <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 mb-2.5">
                  <Globe className="w-3.5 h-3.5" /> Preferred Language
                </label>
                <div className="flex flex-wrap gap-2">
                  {LANGUAGES.map((lang) => {
                    const active = form.language === lang.value;
                    return (
                      <button
                        key={lang.value}
                        type="button"
                        onClick={() => update("language", lang.value)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                          active
                            ? "bg-gray-900 text-white border-gray-900 shadow-sm"
                            : "bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:bg-gray-50"
                        }`}
                      >
                        {lang.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Status */}
              <div>
                <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 mb-2.5">
                  <Sparkles className="w-3.5 h-3.5" /> Initial Status
                </label>
                <div className="flex flex-wrap gap-2">
                  {STATUSES.map((s) => {
                    const active = form.current_status === s.value;
                    return (
                      <button
                        key={s.value}
                        type="button"
                        onClick={() => update("current_status", s.value)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                          active
                            ? `${s.color} ring-1 ${s.ring} border-transparent shadow-sm`
                            : "bg-white text-gray-600 border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${active ? s.dot : "bg-gray-300"}`} />
                        {s.label}
                      </button>
                    );
                  })}
                </div>
                {selectedStatus && (
                  <p className="text-xs text-gray-400 mt-2 ml-0.5">
                    {statusHint(form.current_status)}
                  </p>
                )}
              </div>
            </div>
          </Section>

          {/* ── SUMMARY PILL ───────────────────────────────────── */}
          {(form.dealer_name || form.phone || form.location) && (
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex items-center gap-3">
              <div className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center shrink-0">
                <Store className="w-4 h-4 text-gray-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900 truncate">
                  {form.shop_name || form.dealer_name || "New Lead"}
                </p>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  {form.dealer_name && (
                    <span className="text-xs text-gray-500 flex items-center gap-1">
                      <User className="w-3 h-3" />{form.dealer_name}
                    </span>
                  )}
                  {form.location && (
                    <span className="text-xs text-gray-400 flex items-center gap-1">
                      <MapPin className="w-3 h-3" />{form.location}
                    </span>
                  )}
                  {form.phone && (
                    <span className="text-xs text-gray-400 flex items-center gap-1">
                      <Phone className="w-3 h-3" />{form.phone}
                    </span>
                  )}
                </div>
              </div>
              <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium shrink-0 ${selectedStatus?.color}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${selectedStatus?.dot}`} />
                {selectedStatus?.label}
              </span>
            </div>
          )}
        </div>

        {/* ── FOOTER ACTIONS ──────────────────────────────────── */}
        <div className="flex items-center justify-between mt-6 pt-4">
          <Link href="/leads">
            <button
              type="button"
              className="px-5 py-2.5 text-sm font-medium text-gray-500 hover:text-gray-900 rounded-xl hover:bg-white border border-transparent hover:border-gray-200 transition-all"
            >
              Cancel
            </button>
          </Link>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading}
            className="flex items-center gap-2 px-6 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Creating…
              </>
            ) : (
              <>
                <CheckCircle2 className="w-4 h-4" />
                Create Lead
              </>
            )}
          </button>
        </div>

      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-4 border-b border-gray-100">
        <div className="w-6 h-6 bg-gray-900 rounded-md flex items-center justify-center shrink-0">
          {icon}
        </div>
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      </div>
      <div className="px-5 py-5">{children}</div>
    </div>
  );
}

function Field({
  label,
  required,
  hint,
  error,
  className = "",
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label className="flex items-center gap-1 text-xs font-semibold text-gray-600 mb-1.5">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
        {hint && <span className="text-gray-400 font-normal ml-1">— {hint}</span>}
      </label>
      {children}
      {error && (
        <p className="flex items-center gap-1 text-xs text-red-500 mt-1.5">
          <AlertCircle className="w-3 h-3 shrink-0" />{error}
        </p>
      )}
    </div>
  );
}

function InputWithIcon({
  icon,
  error,
  children,
}: {
  icon: React.ReactNode;
  error?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <div className={`absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none transition-colors ${error ? "text-red-400" : "text-gray-400"}`}>
        {icon}
      </div>
      {children}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────

const inputCls = (error?: boolean) =>
  `w-full h-10 pl-9 pr-4 bg-white border rounded-xl text-sm outline-none transition-all
   placeholder-gray-300 text-gray-900
   focus:ring-2 focus:ring-gray-900/10 focus:border-gray-400
   ${error ? "border-red-400 bg-red-50/30 focus:ring-red-500/10 focus:border-red-400" : "border-gray-200 hover:border-gray-300"}`;

function statusHint(status: string): string {
  const hints: Record<string, string> = {
    new:          "Fresh lead — not yet contacted.",
    cold:         "Low interest — needs nurturing.",
    warm:         "Showing some interest — follow up soon.",
    hot:          "High intent — prioritise immediately.",
    contacted:    "Already reached out, awaiting response.",
    interested:   "Expressed interest — move to qualification.",
    disqualified: "Not a fit — removed from active pipeline.",
    stop:         "Do not contact — excluded from all outreach.",
  };
  return hints[status] ?? "";
}