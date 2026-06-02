"use client";

/**
 * Public FI agent field form — BRD Addendum V0.3.1 §10.3/§10.7.
 *
 * Opened by the agent on their phone, at the customer's address, via a
 * single-use link (no login). Captures browser GPS at open, camera-only photos,
 * the address-match observation, customer-present, and the declaration. GPS
 * denied = hard block (NBFC-configurable). On transient network failure the
 * submission auto-retries a few times before surfacing a manual Retry.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

interface Context {
  customer_name: string;
  address: string | null;
  city: string | null;
  required_photos: string[];
  gps_denied_block: boolean;
  camera_only: boolean;
  expires_at: string | null;
}

interface Geo {
  lat: number;
  lng: number;
  accuracy: number;
}

const PHOTO_LABELS: Record<string, string> = {
  exterior: "House / shop exterior",
  customer_at_residence: "Customer at the residence",
  corroborator: "Name plate / meter / door number",
  agent_selfie: "Your selfie at the address",
  extra: "Extra photo (optional)",
};

export default function FiFieldFormPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";

  const [ctx, setCtx] = useState<Context | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [geo, setGeo] = useState<Geo | null>(null);
  const [geoState, setGeoState] = useState<"idle" | "asking" | "ok" | "denied">("idle");
  const [photos, setPhotos] = useState<Record<string, File>>({});
  const [extras, setExtras] = useState<File[]>([]);
  const [addressMatch, setAddressMatch] = useState<"matches" | "partial" | "no" | "">("");
  const [addressNotes, setAddressNotes] = useState("");
  const [customerPresent, setCustomerPresent] = useState<"yes" | "no" | "">("");
  const [presentNotes, setPresentNotes] = useState("");
  const [agentNotes, setAgentNotes] = useState("");
  const [declared, setDeclared] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const previews = useRef<Record<string, string>>({});

  const askGeo = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setGeoState("denied");
      return;
    }
    setGeoState("asking");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
        setGeoState("ok");
      },
      () => setGeoState("denied"),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/nbfc/fi/field-form/${token}`);
        const j = await res.json();
        if (!res.ok || j.ok === false) {
          setLoadError(j.error ?? "This link is no longer valid.");
          return;
        }
        setCtx(j as Context);
      } catch {
        setLoadError("Could not load the visit. Check your connection and reload.");
      }
    })();
  }, [token]);

  useEffect(() => {
    if (ctx) askGeo();
  }, [ctx, askGeo]);

  function setPhoto(type: string, file: File | null) {
    setPhotos((prev) => {
      const next = { ...prev };
      if (file) {
        if (previews.current[type]) URL.revokeObjectURL(previews.current[type]);
        previews.current[type] = URL.createObjectURL(file);
        next[type] = file;
      } else {
        delete next[type];
      }
      return next;
    });
  }

  const gpsBlocked = (ctx?.gps_denied_block ?? true) && geoState !== "ok";
  const addressNeedsNote = (addressMatch === "partial" || addressMatch === "no") && !addressNotes.trim();
  const presentNeedsNote = customerPresent === "no" && !presentNotes.trim();
  const missingRequired = (ctx?.required_photos ?? []).filter((t) => !photos[t]);
  const canSubmit =
    !!ctx &&
    !gpsBlocked &&
    !!addressMatch &&
    !addressNeedsNote &&
    !!customerPresent &&
    !presentNeedsNote &&
    missingRequired.length === 0 &&
    declared &&
    !submitting;

  async function postOnce(): Promise<{ ok: boolean; error?: string; retryable: boolean }> {
    const fd = new FormData();
    if (geo) {
      fd.set("gps_lat", String(geo.lat));
      fd.set("gps_lng", String(geo.lng));
      fd.set("gps_accuracy_m", String(Math.round(geo.accuracy)));
    }
    fd.set("address_match", addressMatch);
    fd.set("address_match_notes", addressNotes);
    fd.set("customer_present", customerPresent === "yes" ? "true" : "false");
    fd.set("customer_present_notes", presentNotes);
    fd.set("agent_notes", agentNotes);
    fd.set("declaration", declared ? "true" : "false");
    for (const [type, file] of Object.entries(photos)) fd.set(`photo_${type}`, file);
    for (const f of extras) fd.append("photo_extra", f);
    try {
      const res = await fetch(`/api/nbfc/fi/field-form/${token}/submit`, { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok !== false) return { ok: true, retryable: false };
      // 5xx = transient/server; 4xx = our payload, don't retry.
      return { ok: false, error: j.error ?? `HTTP ${res.status}`, retryable: res.status >= 500 };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), retryable: true };
    }
  }

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    // Buffer + auto-retry transient failures (§10.7).
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await postOnce();
      if (r.ok) {
        setDone(true);
        setSubmitting(false);
        return;
      }
      if (!r.retryable) {
        setSubmitError(r.error ?? "Submission failed.");
        setSubmitting(false);
        return;
      }
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
    setSubmitError("Network problem — your visit is saved on this device. Tap Submit to retry.");
    setSubmitting(false);
  }

  // ── render ───────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <Shell>
        <div className="text-center py-10">
          <p className="text-lg font-semibold text-slate-800">Link unavailable</p>
          <p className="text-sm text-slate-500 mt-2">{loadError}</p>
        </div>
      </Shell>
    );
  }
  if (!ctx) {
    return (
      <Shell>
        <p className="text-sm text-slate-500 text-center py-10">Loading visit…</p>
      </Shell>
    );
  }
  if (done) {
    return (
      <Shell>
        <div className="text-center py-10">
          <div className="text-4xl">✅</div>
          <p className="text-lg font-semibold text-slate-800 mt-3">Visit submitted</p>
          <p className="text-sm text-slate-500 mt-2">Thank you. You can close this page.</p>
        </div>
      </Shell>
    );
  }

  const photoSlots = [...(ctx.required_photos ?? [])];

  return (
    <Shell>
      <div className="space-y-5">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Field verification</p>
          <h1 className="text-xl font-bold text-slate-900">{ctx.customer_name}</h1>
          {ctx.address && <p className="text-sm text-slate-600 mt-1">{ctx.address}</p>}
          {ctx.city && <p className="text-xs text-slate-400">{ctx.city}</p>}
        </div>

        {/* GPS */}
        <div className={`rounded-lg border p-3 ${geoState === "ok" ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
          <p className="text-sm font-semibold text-slate-800">Location</p>
          {geoState === "ok" && geo ? (
            <p className="text-xs text-slate-600 mt-1">
              Captured · {geo.lat.toFixed(5)}, {geo.lng.toFixed(5)} (±{Math.round(geo.accuracy)} m)
            </p>
          ) : geoState === "asking" ? (
            <p className="text-xs text-slate-600 mt-1">Requesting location…</p>
          ) : (
            <div className="mt-1">
              <p className="text-xs text-red-600">
                Location is required to submit this visit. Please allow location access.
              </p>
              <button onClick={askGeo} className="mt-2 px-3 py-1.5 rounded-md bg-[color:var(--color-brand-navy,#0f2540)] text-white text-xs font-semibold">
                Enable location
              </button>
            </div>
          )}
        </div>

        {/* Photos */}
        <div className="space-y-3">
          <p className="text-sm font-semibold text-slate-800">Photos</p>
          {photoSlots.map((type) => (
            <PhotoInput
              key={type}
              label={PHOTO_LABELS[type] ?? type}
              cameraOnly={ctx.camera_only}
              preview={photos[type] ? previews.current[type] : undefined}
              onPick={(f) => setPhoto(type, f)}
            />
          ))}
          {/* optional extra */}
          <PhotoInput
            label={PHOTO_LABELS.extra}
            cameraOnly={ctx.camera_only}
            preview={extras[0] ? URL.createObjectURL(extras[0]) : undefined}
            onPick={(f) => setExtras(f ? [f] : [])}
          />
        </div>

        {/* Address match */}
        <Field label="Does the address match?">
          <div className="flex gap-2">
            {(["matches", "partial", "no"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setAddressMatch(v)}
                className={`flex-1 px-2 py-2 rounded-md text-xs font-semibold border ${addressMatch === v ? "bg-[color:var(--color-brand-navy,#0f2540)] text-white border-transparent" : "border-slate-300 text-slate-600"}`}
              >
                {v === "matches" ? "Matches" : v === "partial" ? "Partial" : "No"}
              </button>
            ))}
          </div>
          {(addressMatch === "partial" || addressMatch === "no") && (
            <textarea
              value={addressNotes}
              onChange={(e) => setAddressNotes(e.target.value)}
              rows={2}
              placeholder="Required: describe the mismatch…"
              className="mt-2 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
            />
          )}
        </Field>

        {/* Customer present */}
        <Field label="Was the customer present?">
          <div className="flex gap-2">
            {(["yes", "no"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setCustomerPresent(v)}
                className={`flex-1 px-2 py-2 rounded-md text-xs font-semibold border ${customerPresent === v ? "bg-[color:var(--color-brand-navy,#0f2540)] text-white border-transparent" : "border-slate-300 text-slate-600"}`}
              >
                {v === "yes" ? "Yes" : "No"}
              </button>
            ))}
          </div>
          {customerPresent === "no" && (
            <textarea
              value={presentNotes}
              onChange={(e) => setPresentNotes(e.target.value)}
              rows={2}
              placeholder="Required: who confirmed the address?"
              className="mt-2 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
            />
          )}
        </Field>

        <Field label="Notes (optional)">
          <textarea
            value={agentNotes}
            onChange={(e) => setAgentNotes(e.target.value)}
            rows={2}
            placeholder="Anything else worth recording…"
            className="w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
          />
        </Field>

        <label className="flex items-start gap-2 text-xs text-slate-700">
          <input type="checkbox" checked={declared} onChange={(e) => setDeclared(e.target.checked)} className="mt-0.5" />
          <span>I confirm I personally visited this address and the information submitted is accurate.</span>
        </label>

        {submitError && <p className="text-xs text-red-600">{submitError}</p>}

        <button
          onClick={submit}
          disabled={!canSubmit}
          className="w-full py-3 rounded-lg bg-[color:var(--color-brand-navy,#0f2540)] text-white font-semibold disabled:opacity-50"
        >
          {submitting ? "Submitting…" : "Submit visit"}
        </button>
        {!canSubmit && !submitting && (
          <p className="text-[11px] text-slate-400 text-center">
            {gpsBlocked ? "Enable location, " : ""}
            {missingRequired.length ? `add ${missingRequired.length} required photo(s), ` : ""}
            complete the required fields, and confirm the declaration.
          </p>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-100 py-6 px-4">
      <div className="max-w-md mx-auto bg-white rounded-xl shadow-sm border border-slate-200 p-5">{children}</div>
      <p className="max-w-md mx-auto text-center text-[10px] text-slate-400 mt-4">iTarang Field Investigation</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-sm font-semibold text-slate-800 mb-1.5">{label}</p>
      {children}
    </div>
  );
}

function PhotoInput({
  label,
  cameraOnly,
  preview,
  onPick,
}: {
  label: string;
  cameraOnly: boolean;
  preview?: string;
  onPick: (f: File | null) => void;
}) {
  return (
    <div className="flex items-center gap-3 border border-slate-200 rounded-lg p-2">
      <div className="w-14 h-14 rounded-md bg-slate-100 overflow-hidden flex items-center justify-center shrink-0">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt={label} className="w-full h-full object-cover" />
        ) : (
          <span className="text-2xl text-slate-300">📷</span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-slate-700">{label}</p>
        <label className="inline-block mt-1 text-[11px] font-semibold text-[color:var(--color-brand-sky,#2563eb)] cursor-pointer">
          {preview ? "Retake" : "Take photo"}
          <input
            type="file"
            accept="image/*"
            {...(cameraOnly ? { capture: "environment" as const } : {})}
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
            className="hidden"
          />
        </label>
      </div>
    </div>
  );
}
