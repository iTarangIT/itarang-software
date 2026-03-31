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
} from "lucide-react";
import Link from "next/link";

const LANGUAGES = [
  "Hindi",
  "English",
  "Hinglish",
  "Marathi",
  "Gujarati",
  "Punjabi",
  "Telugu",
  "Tamil",
];
const STATUSES = [
  "new",
  "cold",
  "warm",
  "hot",
  "contacted",
  "interested",
  "disqualified",
  "stop",
];

export default function NewDealerLeadPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState("");

  const [form, setForm] = useState({
    dealer_name: "",
    phone: "",
    shop_name: "",
    location: "",
    language: "Hinglish",
    current_status: "new",
  });

  const update = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field])
      setErrors((prev) => {
        const n = { ...prev };
        delete n[field];
        return n;
      });
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.dealer_name.trim()) e.dealer_name = "Name is required";
    if (!form.phone.trim()) e.phone = "Phone is required";
    else if (!/^\+?[0-9]{10,13}$/.test(form.phone.replace(/\s/g, "")))
      e.phone = "Invalid phone number";
    if (!form.location.trim()) e.location = "Location is required";
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
        body: JSON.stringify(form),
      });

      const data = await res.json();

      if (data.success) {
        router.push("/leads");
      } else {
        setApiError(data.error || "Failed to create lead");
      }
    } catch {
      setApiError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-6 py-8">
        {/* HEADER */}
        <div className="flex items-center gap-3 mb-8">
          <Link
            href="/leads"
            className="p-2 hover:bg-white rounded-lg border border-transparent hover:border-gray-200 transition-all"
          >
            <ChevronLeft className="w-5 h-5 text-gray-600" />
          </Link>
          <div>
            <h1 className="text-xl font-bold text-gray-900">New Dealer Lead</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Add a new dealer to your leads pipeline
            </p>
          </div>
        </div>

        {/* API ERROR */}
        {apiError && (
          <div className="mb-6 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600 font-medium">
            {apiError}
          </div>
        )}

        {/* FORM CARD */}
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          {/* Section: Dealer Info */}
          <div className="px-6 py-5 border-b border-gray-100">
            <div className="flex items-center gap-2 mb-5">
              <div className="w-6 h-6 bg-gray-900 rounded-md flex items-center justify-center">
                <User className="w-3.5 h-3.5 text-white" />
              </div>
              <h2 className="text-sm font-semibold text-gray-900">
                Dealer Information
              </h2>
            </div>

            <div className="space-y-4">
              <Field
                label="Dealer Name"
                required
                error={errors.dealer_name}
                icon={<User className="w-4 h-4 text-gray-400" />}
              >
                <input
                  type="text"
                  value={form.dealer_name}
                  onChange={(e) => update("dealer_name", e.target.value)}
                  placeholder="e.g. Ramesh Kumar"
                  className={inputCls(errors.dealer_name)}
                />
              </Field>

              <Field
                label="Phone Number"
                required
                error={errors.phone}
                icon={<Phone className="w-4 h-4 text-gray-400" />}
              >
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => update("phone", e.target.value)}
                  placeholder="+919876543210"
                  className={inputCls(errors.phone)}
                />
              </Field>
            </div>
          </div>

          {/* Section: Shop Info */}
          <div className="px-6 py-5 border-b border-gray-100">
            <div className="flex items-center gap-2 mb-5">
              <div className="w-6 h-6 bg-gray-900 rounded-md flex items-center justify-center">
                <Store className="w-3.5 h-3.5 text-white" />
              </div>
              <h2 className="text-sm font-semibold text-gray-900">
                Shop Information
              </h2>
            </div>

            <div className="space-y-4">
              <Field
                label="Shop Name"
                icon={<Store className="w-4 h-4 text-gray-400" />}
              >
                <input
                  type="text"
                  value={form.shop_name}
                  onChange={(e) => update("shop_name", e.target.value)}
                  placeholder="e.g. Ramesh Battery Shop"
                  className={inputCls()}
                />
              </Field>

              <Field
                label="Location / City"
                required
                error={errors.location}
                icon={<MapPin className="w-4 h-4 text-gray-400" />}
              >
                <input
                  type="text"
                  value={form.location}
                  onChange={(e) => update("location", e.target.value)}
                  placeholder="e.g. Nashik"
                  className={inputCls(errors.location)}
                />
              </Field>
            </div>
          </div>

          {/* Section: Lead Settings */}
          <div className="px-6 py-5">
            <div className="flex items-center gap-2 mb-5">
              <div className="w-6 h-6 bg-gray-900 rounded-md flex items-center justify-center">
                <Tag className="w-3.5 h-3.5 text-white" />
              </div>
              <h2 className="text-sm font-semibold text-gray-900">
                Lead Settings
              </h2>
            </div>

            <div className="space-y-4">
              {/* Language */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-2 flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5" /> Preferred Language
                </label>
                <div className="flex flex-wrap gap-2">
                  {LANGUAGES.map((lang) => (
                    <button
                      key={lang}
                      onClick={() => update("language", lang.toLowerCase())}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                        form.language === lang.toLowerCase()
                          ? "bg-gray-900 text-white border-gray-900"
                          : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
                      }`}
                    >
                      {lang}
                    </button>
                  ))}
                </div>
              </div>

              {/* Status */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-2">
                  Initial Status
                </label>
                <div className="flex flex-wrap gap-2">
                  {STATUSES.map((s) => {
                    const cfg = STATUS_CONFIG[s] ?? {
                      bg: "bg-gray-100",
                      text: "text-gray-600",
                      activeBg: "bg-gray-900",
                      activeText: "text-white",
                    };
                    const isActive = form.current_status === s;
                    return (
                      <button
                        key={s}
                        onClick={() => update("current_status", s)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border capitalize ${
                          isActive
                            ? `${cfg.activeBg} ${cfg.activeText} border-transparent`
                            : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
                        }`}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ACTIONS */}
        <div className="flex items-center justify-between mt-6">
          <Link href="/leads">
            <button className="px-5 py-2.5 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">
              Cancel
            </button>
          </Link>
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="flex items-center gap-2 px-6 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-700 transition-all disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Creating...
              </>
            ) : (
              "Create Lead"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// HELPERS
const STATUS_CONFIG: Record<string, { activeBg: string; activeText: string }> =
  {
    new: { activeBg: "bg-gray-700", activeText: "text-white" },
    cold: { activeBg: "bg-blue-600", activeText: "text-white" },
    warm: { activeBg: "bg-amber-500", activeText: "text-white" },
    hot: { activeBg: "bg-red-500", activeText: "text-white" },
    contacted: { activeBg: "bg-purple-600", activeText: "text-white" },
    interested: { activeBg: "bg-emerald-600", activeText: "text-white" },
    disqualified: { activeBg: "bg-zinc-500", activeText: "text-white" },
    stop: { activeBg: "bg-red-700", activeText: "text-white" },
  };

const inputCls = (error?: string) =>
  `w-full h-10 pl-9 pr-4 bg-white border rounded-lg text-sm outline-none transition-all placeholder-gray-300 focus:ring-2 focus:ring-gray-900/10 focus:border-gray-400 ${
    error ? "border-red-400" : "border-gray-200"
  }`;

function Field({
  label,
  required,
  error,
  icon,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1.5">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <div className="relative">
        {icon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
            {icon}
          </div>
        )}
        {children}
      </div>
      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
    </div>
  );
}
