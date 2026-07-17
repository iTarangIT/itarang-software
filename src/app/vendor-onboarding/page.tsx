"use client";

/**
 * Scrap vendor self-registration (E-195, BRD M24).
 *
 * PUBLIC, and outside both the (auth) and (dashboard) route groups — a recycler
 * registering has no session yet, exactly like /dealer-onboarding. Middleware's
 * isProtectedRoute is derived from roleDashboards plus a hardcoded prefix list,
 * and "/vendor-onboarding" is in neither, so it stays reachable.
 *
 * ONE PAGE, NOT A WIZARD. The dealer's six-step flow exists because a dealer
 * needs KYC, ownership, finance and a signed agreement before they can borrow
 * money. A vendor is just someone who buys scrap: what iTarang needs to start
 * quoting them is who they are, how to reach them, and what they want. GST
 * verification and the Digio agreement are M18/M19 — gating sign-up on those
 * would recreate the bottleneck this page removes.
 *
 * The honest promise at the end matters: registering gets you a LOGIN, not
 * work. Nothing routes to you until an admin approves.
 */

import { useState } from "react";
import Link from "next/link";

const CHEMISTRY_OPTIONS = [
  { value: "NMC", label: "NMC" },
  { value: "LFP", label: "LFP" },
] as const;

const input =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none";
const label = "mb-1 block text-[12px] font-semibold text-slate-600";

export default function VendorOnboardingPage() {
  const [form, setForm] = useState({
    name: "",
    gstin: "",
    pan: "",
    contact_name: "",
    email: "",
    password: "",
    contact_phone: "",
    city: "",
    state: "",
    regions: "",
  });
  const [categories, setCategories] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    setError(null);
    setSubmitting(true);

    const res = await fetch("/api/vendor/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name.trim(),
        gstin: form.gstin.trim().toUpperCase(),
        pan: form.pan.trim().toUpperCase() || undefined,
        contact_name: form.contact_name.trim(),
        email: form.email.trim(),
        password: form.password,
        contact_phone: form.contact_phone.trim() || undefined,
        city: form.city.trim() || undefined,
        state: form.state.trim() || undefined,
        categories,
        // "Maharashtra, Gujarat" — one box, because asking a recycler to manage
        // a tag editor to tell us two state names is not worth anyone's time.
        regions: form.regions
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean),
      }),
    }).catch(() => null);

    const json = await res?.json().catch(() => null);
    setSubmitting(false);

    if (!json?.success) {
      // Zod refusals arrive per-field in details; show the first one, since it
      // names the field, rather than the generic envelope message.
      const detail = json?.error?.details?.[0]?.message;
      setError(detail ?? json?.error?.message ?? "Could not complete your registration.");
      return;
    }

    setDone(true);
  };

  if (done) {
    return (
      <div className="min-h-screen bg-slate-50 px-6 py-16">
        <div className="mx-auto max-w-[560px] rounded-xl border border-slate-200 bg-white p-8 text-center">
          <div className="text-3xl">✅</div>
          <h1 className="mt-3 text-lg font-bold text-slate-900">You&apos;re registered</h1>
          {/* Says the quiet part out loud. A vendor who signs in to an empty
              dashboard with no explanation concludes we are broken. */}
          <p className="mt-2 text-[13.5px] text-slate-600">
            Your login is ready. An iTarang admin will review your details before you start
            receiving battery lots — until then your dashboard will be empty.
          </p>
          <Link
            href="/login"
            className="mt-5 inline-block rounded-lg bg-bb-navy px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90"
          >
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 px-6 py-10">
      <div className="mx-auto max-w-[720px]">
        <h1 className="text-xl font-bold text-slate-900">Register as a scrap vendor</h1>
        <p className="mt-1 text-[13.5px] text-slate-600">
          Buy end-of-life battery lots from iTarang. Takes a minute — we&apos;ll review your
          details before sending you anything.
        </p>

        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="text-[13px] font-bold uppercase tracking-wide text-slate-400">
            Your login
          </h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <label className={label}>Email *</label>
              <input value={form.email} onChange={set("email")} type="email" className={input} />
            </div>
            <div>
              <label className={label}>Password *</label>
              <input
                value={form.password}
                onChange={set("password")}
                type="password"
                placeholder="At least 8 characters"
                className={input}
              />
            </div>
          </div>

          <h2 className="mt-7 text-[13px] font-bold uppercase tracking-wide text-slate-400">
            Your business
          </h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <label className={label}>Business name *</label>
              <input value={form.name} onChange={set("name")} className={input} />
            </div>
            <div>
              <label className={label}>Contact person *</label>
              <input value={form.contact_name} onChange={set("contact_name")} className={input} />
            </div>
            <div>
              <label className={label}>GSTIN *</label>
              <input
                value={form.gstin}
                onChange={set("gstin")}
                placeholder="15 characters"
                className={`${input} uppercase`}
              />
              {/* Why we insist on it up front, rather than letting them wonder. */}
              <p className="mt-1 text-[11.5px] text-slate-400">
                We invoice you against this, so we need it before we can sell to you.
              </p>
            </div>
            <div>
              <label className={label}>PAN</label>
              <input value={form.pan} onChange={set("pan")} className={`${input} uppercase`} />
            </div>
            <div>
              <label className={label}>Phone</label>
              <input value={form.contact_phone} onChange={set("contact_phone")} className={input} />
            </div>
            <div>
              <label className={label}>City</label>
              <input value={form.city} onChange={set("city")} className={input} />
            </div>
            <div>
              <label className={label}>State</label>
              <input value={form.state} onChange={set("state")} className={input} />
            </div>
          </div>

          <h2 className="mt-7 text-[13px] font-bold uppercase tracking-wide text-slate-400">
            What you collect
          </h2>
          <p className="mt-1 text-[12px] text-slate-500">
            Used to decide which lots to send you. You can change this later.
          </p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <label className={label}>Chemistry</label>
              <div className="flex gap-2">
                {CHEMISTRY_OPTIONS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() =>
                      setCategories((cs) =>
                        cs.includes(c.value)
                          ? cs.filter((x) => x !== c.value)
                          : [...cs, c.value],
                      )
                    }
                    className={`rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold ${
                      categories.includes(c.value)
                        ? "border-bb-navy bg-bb-navy text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className={label}>States you collect from</label>
              <input
                value={form.regions}
                onChange={set("regions")}
                placeholder="Maharashtra, Gujarat"
                className={input}
              />
            </div>
          </div>

          {error && (
            <p className="mt-5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] font-semibold text-red-700">
              {error}
            </p>
          )}

          <div className="mt-6 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={submitting}
              className="rounded-lg bg-green-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "Registering…" : "Register"}
            </button>
            <Link href="/login" className="text-[13px] font-semibold text-slate-500 hover:underline">
              Already registered? Sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
