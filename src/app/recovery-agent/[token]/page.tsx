"use client";

/**
 * E-262 / E-263 — the recovery agent's field form.
 *
 * Opened on a phone, at the borrower's address, from a single-use link. No
 * login: the token is the credential.
 *
 * TWO OUTCOMES, BOTH FIRST-CLASS. The agent either has the battery or they do
 * not, and the second is the common case — nobody home, or home and refusing.
 * Giving "Not present" equal billing with "Collected" is the whole point: an
 * agent whose only button says COLLECTED either lies or does nothing, and doing
 * nothing looks exactly like never having left the house.
 *
 * Location is required for both. It is what turns "I went" into a record.
 *
 * Styled inline and heavier than the rest of the app on purpose: this is read
 * one-handed, outdoors, in sunlight, by somebody who is not a CRM user.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

interface Visit {
  attempt_no: number;
  outcome: string;
  notes: string | null;
  next_visit_at: string | null;
  created_at: string;
}

interface Job {
  assignment_id: string;
  borrower_name: string;
  borrower_phone: string | null;
  address: string | null;
  city: string | null;
  dealer_name: string | null;
  nbfc_name: string | null;
  battery_serial: string | null;
  expires_at: string | null;
  previous_visits: Visit[];
}

interface Geo {
  lat: number;
  lng: number;
  accuracy: number;
}

const PHOTO_SLOTS = [
  { key: "serial", label: "The serial plate", hint: "Close enough to read the number" },
  { key: "battery", label: "The battery as you found it", hint: "Whole unit, in place" },
  { key: "vehicle", label: "The vehicle", hint: "Optional" },
  { key: "agent_selfie", label: "You, at the address", hint: "Optional" },
] as const;

const OUTCOMES = [
  { key: "not_present", label: "Customer not present" },
  { key: "refused", label: "Customer refused to hand it over" },
  { key: "address_not_found", label: "Could not find the address" },
  { key: "battery_missing", label: "Battery is not at the address" },
  { key: "other", label: "Something else" },
] as const;

const OUTCOME_LABELS: Record<string, string> = Object.fromEntries(
  OUTCOMES.map((o) => [o.key, o.label]),
);

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------
const page: React.CSSProperties = {
  minHeight: "100dvh",
  background: "#f1f5f9",
  color: "#0f172a",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  padding: "1rem",
  boxSizing: "border-box",
};
const card: React.CSSProperties = {
  maxWidth: "34rem",
  margin: "0 auto 1rem",
  background: "#fff",
  borderRadius: 12,
  padding: "1.125rem",
  boxShadow: "0 1px 3px rgba(15,23,42,.12)",
};
const h1: React.CSSProperties = { fontSize: "1.125rem", fontWeight: 700, margin: "0 0 .25rem" };
const label: React.CSSProperties = {
  display: "block",
  fontSize: ".6875rem",
  fontWeight: 700,
  letterSpacing: ".08em",
  textTransform: "uppercase",
  color: "#64748b",
  marginBottom: ".25rem",
};
const input: React.CSSProperties = {
  width: "100%",
  fontSize: "1rem",
  padding: ".625rem .75rem",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  boxSizing: "border-box",
  background: "#fff",
};
const btn = (bg: string, fg = "#fff"): React.CSSProperties => ({
  width: "100%",
  fontSize: "1rem",
  fontWeight: 700,
  padding: ".875rem 1rem",
  border: "none",
  borderRadius: 10,
  background: bg,
  color: fg,
  cursor: "pointer",
});

export default function RecoveryAgentFormPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";

  const [job, setJob] = useState<Job | null>(null);
  const [dead, setDead] = useState<{ state: string; message: string; reason?: string } | null>(
    null,
  );
  const [mode, setMode] = useState<"choose" | "collect" | "visit">("choose");

  const [geo, setGeo] = useState<Geo | null>(null);
  const [geoState, setGeoState] = useState<"idle" | "asking" | "ok" | "denied">("idle");

  const [photos, setPhotos] = useState<Record<string, File>>({});
  const [extras, setExtras] = useState<File[]>([]);
  const [serial, setSerial] = useState("");
  const [condition, setCondition] = useState("");
  const [declared, setDeclared] = useState(false);

  const [outcome, setOutcome] = useState("");
  const [visitNotes, setVisitNotes] = useState("");
  const [nextVisit, setNextVisit] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | { kind: "collected" | "visit"; text: string }>(null);
  const previews = useRef<Record<string, string>>({});

  const askGeo = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setGeoState("denied");
      return;
    }
    setGeoState("asking");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
        setGeoState("ok");
      },
      () => setGeoState("denied"),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/nbfc/recovery/agent-form/${token}`);
        const j = await res.json();
        if (cancelled) return;
        if (!res.ok || j.ok === false) {
          setDead({ state: j.state ?? "unknown", message: j.message ?? "This link is not valid.", reason: j.reason });
          return;
        }
        setJob(j as Job);
        setSerial(j.battery_serial ?? "");
        // Ask for the location the moment the job loads, rather than making the
        // agent find a button first. Both submit paths are blocked without it,
        // so the permission prompt is going to happen either way — better while
        // they are still reading the address than after they have filled the
        // form in. The manual button stays for a denial or a retry.
        askGeo();
      } catch {
        if (!cancelled) {
          setDead({
            state: "offline",
            message: "Could not load the job. Check your signal and reload.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, askGeo]);

  function setSlot(key: string, file: File | undefined) {
    if (!file) return;
    if (previews.current[key]) URL.revokeObjectURL(previews.current[key]);
    previews.current[key] = URL.createObjectURL(file);
    setPhotos((p) => ({ ...p, [key]: file }));
  }

  async function submitCollection() {
    if (!geo) {
      setError("Turn on location first — it is required.");
      return;
    }
    if (!serial.trim()) {
      setError("Enter the battery serial from the casing.");
      return;
    }
    if (Object.keys(photos).length === 0 && extras.length === 0) {
      setError("Take at least one photograph.");
      return;
    }
    if (!declared) {
      setError("Tick the declaration.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("gps_lat", String(geo.lat));
      fd.set("gps_lng", String(geo.lng));
      fd.set("gps_accuracy_m", String(geo.accuracy));
      fd.set("battery_serial", serial.trim());
      fd.set("condition_notes", condition.trim());
      fd.set("declaration", "true");
      for (const [k, f] of Object.entries(photos)) fd.set(`photo_${k}`, f);
      for (const f of extras) fd.append("photo_extra", f);
      const res = await fetch(`/api/nbfc/recovery/agent-form/${token}/submit`, {
        method: "POST",
        body: fd,
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      setDone({
        kind: "collected",
        text: "Collection recorded. The office can see your photographs and location.",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitVisit() {
    if (!geo) {
      setError("Turn on location first — it is what shows the office you attended.");
      return;
    }
    if (!outcome) {
      setError("Say what happened.");
      return;
    }
    if (outcome === "other" && !visitNotes.trim()) {
      setError("Describe what happened.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("gps_lat", String(geo.lat));
      fd.set("gps_lng", String(geo.lng));
      fd.set("gps_accuracy_m", String(geo.accuracy));
      fd.set("outcome", outcome);
      fd.set("notes", visitNotes.trim());
      if (nextVisit) fd.set("next_visit_at", new Date(nextVisit).toISOString());
      for (const f of extras) fd.append("photo_extra", f);
      const res = await fetch(`/api/nbfc/recovery/agent-form/${token}/visit`, {
        method: "POST",
        body: fd,
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      setDone({
        kind: "visit",
        text: nextVisit
          ? `Reported. The office knows you attended and that you will return on ${new Date(
              nextVisit,
            ).toLocaleString("en-IN")}. Your link still works — use it when you go back.`
          : "Reported. The office knows you attended and found nothing to collect.",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------- dead link
  if (dead) {
    const bad = dead.state === "cancelled";
    return (
      <div style={page}>
        <div style={{ ...card, borderTop: `4px solid ${bad ? "#dc2626" : "#94a3b8"}` }}>
          <h1 style={{ ...h1, color: bad ? "#991b1b" : "#0f172a" }}>
            {bad ? "Do not collect" : "This link is closed"}
          </h1>
          <p style={{ fontSize: ".9375rem", lineHeight: 1.6, margin: ".5rem 0 0" }}>
            {dead.message}
          </p>
          {dead.reason ? (
            <p style={{ fontSize: ".875rem", color: "#64748b", marginTop: ".5rem" }}>
              Reason given: {dead.reason}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  if (!job) {
    return (
      <div style={page}>
        <div style={card}>
          <p style={{ color: "#64748b" }}>Loading your job…</p>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------- done
  if (done) {
    return (
      <div style={page}>
        <div style={{ ...card, borderTop: "4px solid #059669" }}>
          <h1 style={h1}>
            {done.kind === "collected" ? "Thank you — collected" : "Thank you — reported"}
          </h1>
          <p style={{ fontSize: ".9375rem", lineHeight: 1.6 }}>{done.text}</p>
        </div>
      </div>
    );
  }

  const geoBlock = (
    <div style={{ ...card, borderLeft: geo ? "4px solid #059669" : "4px solid #d97706" }}>
      <span style={label}>Your location</span>
      {geo ? (
        <p style={{ margin: 0, fontSize: ".9375rem" }}>
          Captured · accurate to about {Math.round(geo.accuracy)} m
        </p>
      ) : (
        <>
          <p style={{ margin: "0 0 .625rem", fontSize: ".9375rem", lineHeight: 1.5 }}>
            {geoState === "denied"
              ? "Location was blocked. Allow it in your browser settings and press again — you cannot submit without it."
              : "Required for both options below. It is what shows the office you attended."}
          </p>
          <button
            type="button"
            style={btn("#0f2540")}
            onClick={askGeo}
            disabled={geoState === "asking"}
          >
            {geoState === "asking" ? "Finding you…" : "Capture my location"}
          </button>
        </>
      )}
    </div>
  );

  return (
    <div style={page}>
      {/* --------------------------------------------------------- job card */}
      <div style={card}>
        <p style={{ ...label, marginBottom: ".375rem" }}>
          Battery collection{job.nbfc_name ? ` · ${job.nbfc_name}` : ""}
        </p>
        <h1 style={h1}>{job.borrower_name}</h1>
        {job.address ? (
          <p style={{ margin: ".25rem 0", fontSize: ".9375rem", lineHeight: 1.5 }}>
            {job.address}
            {job.city ? `, ${job.city}` : ""}
          </p>
        ) : null}
        {job.borrower_phone ? (
          <p style={{ margin: ".5rem 0 0" }}>
            <a
              href={`tel:${job.borrower_phone}`}
              style={{
                display: "inline-block",
                padding: ".5rem .875rem",
                background: "#e2e8f0",
                borderRadius: 8,
                color: "#0f172a",
                textDecoration: "none",
                fontWeight: 600,
              }}
            >
              Call {job.borrower_phone}
            </a>
          </p>
        ) : null}
        {job.battery_serial ? (
          <p style={{ margin: ".625rem 0 0", fontFamily: "ui-monospace, monospace" }}>
            {job.battery_serial}
          </p>
        ) : (
          <p style={{ margin: ".625rem 0 0", fontSize: ".875rem", color: "#b45309" }}>
            No serial on file — read it off the casing when you get there.
          </p>
        )}

        {job.previous_visits.length > 0 ? (
          <div style={{ marginTop: ".875rem", borderTop: "1px solid #e2e8f0", paddingTop: ".625rem" }}>
            <span style={label}>You have already been</span>
            {job.previous_visits.map((v) => (
              <p key={v.attempt_no} style={{ margin: ".25rem 0", fontSize: ".8125rem", color: "#475569" }}>
                Visit {v.attempt_no} ·{" "}
                {new Date(v.created_at).toLocaleDateString("en-IN")} ·{" "}
                {OUTCOME_LABELS[v.outcome] ?? v.outcome}
                {v.notes ? ` — ${v.notes}` : ""}
              </p>
            ))}
          </div>
        ) : null}
      </div>

      {geoBlock}

      {/* ----------------------------------------------------- the two paths */}
      {mode === "choose" ? (
        <div style={card}>
          <span style={label}>What happened?</span>
          <button
            type="button"
            style={{ ...btn("#0f2540"), marginBottom: ".625rem" }}
            onClick={() => {
              setMode("collect");
              setError(null);
            }}
          >
            I have the battery
          </button>
          <button
            type="button"
            style={btn("#fff", "#0f172a")}
            onClick={() => {
              setMode("visit");
              setError(null);
            }}
          >
            <span style={{ borderBottom: "2px solid #cbd5e1", paddingBottom: 2 }}>
              Not present / could not collect
            </span>
          </button>
        </div>
      ) : null}

      {/* ------------------------------------------------------- collection */}
      {mode === "collect" ? (
        <div style={card}>
          <span style={label}>Battery serial</span>
          <input
            style={{ ...input, fontFamily: "ui-monospace, monospace", marginBottom: ".875rem" }}
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            placeholder="Read it off the casing"
          />

          <span style={label}>Photographs</span>
          {PHOTO_SLOTS.map((slot) => (
            <label
              key={slot.key}
              style={{
                display: "block",
                border: `1px solid ${photos[slot.key] ? "#059669" : "#cbd5e1"}`,
                borderRadius: 8,
                padding: ".75rem",
                marginBottom: ".5rem",
                cursor: "pointer",
              }}
            >
              <span style={{ fontWeight: 600, fontSize: ".9375rem" }}>
                {photos[slot.key] ? "✓ " : ""}
                {slot.label}
              </span>
              <span style={{ display: "block", fontSize: ".75rem", color: "#64748b" }}>
                {slot.hint}
              </span>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                style={{ display: "none" }}
                onChange={(e) => {
                  setSlot(slot.key, e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
          ))}

          <span style={label}>Condition, as you found it</span>
          <textarea
            style={{ ...input, minHeight: "4.5rem", marginBottom: ".875rem" }}
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            placeholder="Cracked casing, charger missing, anything the workshop should know."
          />

          <label
            style={{
              display: "flex",
              gap: ".5rem",
              alignItems: "flex-start",
              marginBottom: ".875rem",
              fontSize: ".875rem",
              lineHeight: 1.5,
            }}
          >
            <input
              type="checkbox"
              checked={declared}
              onChange={(e) => setDeclared(e.target.checked)}
              style={{ marginTop: ".2rem", width: "1.125rem", height: "1.125rem" }}
            />
            <span>
              I collected this battery myself, at this address, and the photographs
              above are of that battery.
            </span>
          </label>

          <button
            type="button"
            style={btn(geo && declared ? "#0f2540" : "#94a3b8")}
            disabled={busy}
            onClick={submitCollection}
          >
            {busy ? "Sending…" : "Submit collection"}
          </button>
          <button
            type="button"
            style={{ ...btn("transparent", "#64748b"), padding: ".625rem" }}
            onClick={() => setMode("choose")}
            disabled={busy}
          >
            Back
          </button>
        </div>
      ) : null}

      {/* ---------------------------------------------------- not collected */}
      {mode === "visit" ? (
        <div style={card}>
          <span style={label}>What happened?</span>
          <div style={{ marginBottom: ".875rem" }}>
            {OUTCOMES.map((o) => (
              <label
                key={o.key}
                style={{
                  display: "flex",
                  gap: ".5rem",
                  alignItems: "center",
                  border: `1px solid ${outcome === o.key ? "#0f2540" : "#cbd5e1"}`,
                  borderRadius: 8,
                  padding: ".75rem",
                  marginBottom: ".375rem",
                  cursor: "pointer",
                  fontSize: ".9375rem",
                }}
              >
                <input
                  type="radio"
                  name="outcome"
                  checked={outcome === o.key}
                  onChange={() => setOutcome(o.key)}
                  style={{ width: "1.125rem", height: "1.125rem" }}
                />
                {o.label}
              </label>
            ))}
          </div>

          <span style={label}>Anything the office should know</span>
          <textarea
            style={{ ...input, minHeight: "4.5rem", marginBottom: ".875rem" }}
            value={visitNotes}
            onChange={(e) => setVisitNotes(e.target.value)}
            placeholder="Neighbour said they work nights. Gate locked. Etc."
          />

          <span style={label}>When will you go back?</span>
          <input
            type="datetime-local"
            style={{ ...input, marginBottom: ".375rem" }}
            value={nextVisit}
            onChange={(e) => setNextVisit(e.target.value)}
          />
          <p style={{ fontSize: ".75rem", color: "#64748b", margin: "0 0 .875rem", lineHeight: 1.5 }}>
            Leave it blank if you are not going back. Your link keeps working
            either way — use the same one when you return.
          </p>

          <label
            style={{
              display: "block",
              border: "1px solid #cbd5e1",
              borderRadius: 8,
              padding: ".75rem",
              marginBottom: ".875rem",
              cursor: "pointer",
              fontSize: ".9375rem",
            }}
          >
            <span style={{ fontWeight: 600 }}>
              {extras.length > 0 ? `✓ ${extras.length} photo(s) added` : "Add a photo (optional)"}
            </span>
            <span style={{ display: "block", fontSize: ".75rem", color: "#64748b" }}>
              A locked gate, a wrong door number — whatever shows what you found.
            </span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                setExtras((x) => [...x, ...Array.from(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </label>

          <button
            type="button"
            style={btn(geo && outcome ? "#0f2540" : "#94a3b8")}
            disabled={busy}
            onClick={submitVisit}
          >
            {busy ? "Sending…" : "Report this visit"}
          </button>
          <button
            type="button"
            style={{ ...btn("transparent", "#64748b"), padding: ".625rem" }}
            onClick={() => setMode("choose")}
            disabled={busy}
          >
            Back
          </button>
        </div>
      ) : null}

      {error ? (
        <div style={{ ...card, borderLeft: "4px solid #dc2626" }}>
          <p style={{ margin: 0, color: "#991b1b", fontSize: ".9375rem" }}>{error}</p>
        </div>
      ) : null}
    </div>
  );
}
