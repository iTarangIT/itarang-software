"use client";

/**
 * E-262 — Recovery Agent Directory.
 *
 * The people this NBFC sends to collect a flagged battery. They are contact
 * records, not accounts: an agent is dispatched with a single-use link and
 * never logs in, which is why there is no invite, no password and no role here.
 *
 * A full settings section rather than a link tucked inside another one (the way
 * the FI directory sits under Service Opt-In), because this list is not a
 * sub-setting of anything — the Recovery queue is unusable until it has a name
 * in it, so it earns its own card.
 *
 * Deactivated agents stay visible and greyed. They are out of the assign picker
 * but their past collections still name them, and reactivating beats re-typing.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Channel = "email" | "sms" | "whatsapp";

interface Agent {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  city: string | null;
  coverage_area: string | null;
  preferred_channel: Channel;
  reference_photo_url: string | null;
  active: boolean;
}

interface Draft {
  name: string;
  phone: string;
  email: string;
  city: string;
  coverage_area: string;
  preferred_channel: Channel;
  reference_photo_url: string;
}

const BLANK: Draft = {
  name: "",
  phone: "",
  email: "",
  city: "",
  coverage_area: "",
  preferred_channel: "email",
  reference_photo_url: "",
};

const INPUT =
  "text-xs border border-slate-300 dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-950";

export default function RecoveryAgentDirectory({ canEdit }: { canEdit: boolean }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>({ ...BLANK });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>({ ...BLANK });
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/nbfc/recovery/agents");
      const j = await res.json();
      if (j.ok) setAgents(j.agents as Agent[]);
      else setError(j.error ?? `HTTP ${res.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function uploadRef(file: File, into: "draft" | "edit") {
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      // Deliberately a bare fetch: a JSON content-type header would destroy the
      // multipart boundary.
      const res = await fetch("/api/nbfc/recovery/agents/reference-photo", {
        method: "POST",
        body: fd,
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (into === "draft") setDraft((d) => ({ ...d, reference_photo_url: j.fileUrl }));
      else setEditDraft((d) => ({ ...d, reference_photo_url: j.fileUrl }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  function validate(d: Draft): string | null {
    if (!d.name.trim()) return "Name is required.";
    if (!d.phone.trim()) return "Phone is required — it is how an agent is reached.";
    if (d.preferred_channel === "email" && !d.email.trim()) {
      return "An email address is required when the preferred channel is email.";
    }
    return null;
  }

  async function addAgent() {
    const problem = validate(draft);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/nbfc/recovery/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      setDraft({ ...BLANK });
      setAdding(false);
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: string) {
    const problem = validate(editDraft);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/recovery/agents/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(editDraft),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      setEditingId(null);
      setEditDraft({ ...BLANK });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(a: Agent) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/recovery/agents/${a.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: !a.active }),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(a: Agent) {
    setError(null);
    setEditingId(a.id);
    setEditDraft({
      name: a.name,
      phone: a.phone,
      email: a.email ?? "",
      city: a.city ?? "",
      coverage_area: a.coverage_area ?? "",
      preferred_channel: a.preferred_channel,
      reference_photo_url: a.reference_photo_url ?? "",
    });
  }

  const activeCount = agents.filter((a) => a.active).length;

  function fields(d: Draft, set: (d: Draft) => void, which: "draft" | "edit") {
    return (
      <>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input
            value={d.name}
            onChange={(e) => set({ ...d, name: e.target.value })}
            placeholder="Name *"
            className={INPUT}
          />
          <input
            value={d.phone}
            onChange={(e) => set({ ...d, phone: e.target.value })}
            placeholder="Phone *"
            className={INPUT}
          />
          <input
            value={d.email}
            onChange={(e) => set({ ...d, email: e.target.value })}
            placeholder="Email"
            className={INPUT}
          />
          <input
            value={d.city}
            onChange={(e) => set({ ...d, city: e.target.value })}
            placeholder="City"
            className={INPUT}
          />
          <input
            value={d.coverage_area}
            onChange={(e) => set({ ...d, coverage_area: e.target.value })}
            placeholder="Coverage area — e.g. Ranchi + 60km"
            className={INPUT}
          />
          <select
            value={d.preferred_channel}
            onChange={(e) => set({ ...d, preferred_channel: e.target.value as Channel })}
            className={INPUT}
          >
            <option value="email">Send the link by email</option>
            <option value="sms">Send the link by SMS</option>
            <option value="whatsapp">Send the link by WhatsApp</option>
          </select>
          <label className={`${INPUT} cursor-pointer text-slate-600 flex items-center`}>
            {uploading
              ? "Uploading…"
              : d.reference_photo_url
                ? "Reference photo ✓"
                : "Reference photo"}
            <input
              ref={which === "draft" ? fileRef : undefined}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) =>
                e.target.files?.[0] && uploadRef(e.target.files[0], which)
              }
            />
          </label>
        </div>
        <p className="text-[10px] text-slate-500">
          The reference photo is what a reviewer compares the selfie from the
          doorstep against. Optional, and only ever seen inside this portal.
        </p>
      </>
    );
  }

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100">
            Recovery Agents
          </h2>
          <p className="text-[11px] text-slate-500 mt-0.5 max-w-2xl">
            The people you send to collect a flagged battery. They do not log in —
            assigning one emails them a single-use link that captures their
            location and photographs at the borrower&apos;s address. Add at least one
            before dispatching from the Recovery queue.
          </p>
        </div>
        {loaded ? (
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 shrink-0">
            {activeCount} active
          </span>
        ) : null}
      </div>

      {!loaded ? (
        <p className="text-[11px] text-slate-400">Loading…</p>
      ) : agents.length === 0 ? (
        <p className="text-[11px] text-slate-500">
          No recovery agents yet.
          {canEdit ? " Add the first one below." : ""}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {agents.map((a) => (
            <li
              key={a.id}
              className="text-xs border-b border-slate-100 dark:border-slate-800 last:border-0 pb-1.5 last:pb-0"
            >
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded bg-slate-100 dark:bg-slate-800 overflow-hidden flex items-center justify-center shrink-0">
                  {a.reference_photo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={a.reference_photo_url}
                      alt={a.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <span className="text-slate-300">👤</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p
                    className={`font-medium ${
                      a.active
                        ? "text-slate-800 dark:text-slate-100"
                        : "text-slate-400 line-through"
                    }`}
                  >
                    {a.name}
                  </p>
                  <p className="text-[10px] text-slate-500 truncate">
                    {a.phone}
                    {a.city ? ` · ${a.city}` : ""}
                    {a.coverage_area ? ` · ${a.coverage_area}` : ""}
                    {a.email ? ` · ${a.email}` : ""} · link by {a.preferred_channel}
                  </p>
                </div>
                {canEdit && editingId !== a.id ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => startEdit(a)}
                      disabled={busy}
                      className="text-[10px] font-semibold text-[color:var(--color-brand-sky)] underline"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => toggleActive(a)}
                      disabled={busy}
                      className="text-[10px] font-semibold text-slate-500 underline"
                    >
                      {a.active ? "Deactivate" : "Reactivate"}
                    </button>
                  </div>
                ) : null}
              </div>

              {canEdit && editingId === a.id ? (
                <div className="mt-2 ml-10 space-y-2">
                  {fields(editDraft, setEditDraft, "edit")}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => saveEdit(a.id)}
                      disabled={busy || uploading}
                      className="px-3 py-1 rounded-md bg-[color:var(--color-brand-navy)] text-white text-xs font-semibold disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setEditingId(null);
                        setEditDraft({ ...BLANK });
                      }}
                      disabled={busy}
                      className="text-[11px] font-semibold text-slate-500 underline"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
        adding ? (
          <div className="border-t border-slate-200 dark:border-slate-700 pt-3 space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
              Add agent
            </p>
            {fields(draft, setDraft, "draft")}
            <div className="flex items-center gap-2">
              <button
                onClick={addAgent}
                disabled={busy || uploading}
                className="px-3 py-1.5 rounded-md bg-[color:var(--color-brand-navy)] text-white text-xs font-semibold disabled:opacity-50"
              >
                Add agent
              </button>
              <button
                onClick={() => {
                  setAdding(false);
                  setDraft({ ...BLANK });
                  setError(null);
                }}
                disabled={busy}
                className="text-[11px] font-semibold text-slate-500 underline"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => {
              setAdding(true);
              setError(null);
            }}
            className="text-[11px] font-semibold text-[color:var(--color-brand-sky)] underline"
          >
            Add a recovery agent →
          </button>
        )
      ) : null}

      {error ? <p className="text-[11px] text-red-600">{error}</p> : null}
    </section>
  );
}
