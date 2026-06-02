"use client";

/**
 * FI Agent Directory — BRD Addendum V0.3.1 §10.5/§15.4.2.
 *
 * Manage the per-NBFC list of field agents used for single-use link dispatch
 * and Coordinator selfie comparison. Self-contained: CRUDs via /api/nbfc/fi/agents.
 * Agents are NOT iTarang users — these are lightweight contact records.
 */
import { useCallback, useEffect, useRef, useState } from "react";

interface Agent {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  city: string | null;
  preferred_channel: "email" | "sms" | "whatsapp";
  reference_photo_url: string | null;
  active: boolean;
}

const BLANK = { name: "", phone: "", email: "", city: "", preferred_channel: "email" as const, reference_photo_url: "" };

export default function FiAgentDirectory({ canEdit }: { canEdit: boolean }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<typeof BLANK>({ ...BLANK });
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/nbfc/fi/agents");
      const j = await res.json();
      if (j.ok) setAgents(j.agents as Agent[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function uploadRef(file: File) {
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch("/api/nbfc/fi/agents/reference-photo", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      setDraft((d) => ({ ...d, reference_photo_url: j.fileUrl }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  async function addAgent() {
    if (!draft.name.trim() || !draft.phone.trim()) {
      setError("Name and phone are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/nbfc/fi/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      setDraft({ ...BLANK });
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(a: Agent) {
    setBusy(true);
    try {
      await fetch(`/api/nbfc/fi/agents/${a.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: !a.active }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2">
      <button onClick={() => setOpen((s) => !s)} className="text-[11px] font-semibold text-[color:var(--color-brand-sky)] underline">
        {open ? "Hide FI agents" : "Manage FI Agents →"}
      </button>

      {open && (
        <div className="mt-2 border border-slate-200 dark:border-slate-700 rounded-lg p-3 space-y-3">
          {/* List */}
          {agents.length === 0 ? (
            <p className="text-[11px] text-slate-500">No agents yet. Add one below.</p>
          ) : (
            <ul className="space-y-1.5">
              {agents.map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-xs">
                  <div className="w-8 h-8 rounded bg-slate-100 overflow-hidden flex items-center justify-center shrink-0">
                    {a.reference_photo_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.reference_photo_url} alt={a.name} className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-slate-300">👤</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`font-medium ${a.active ? "text-slate-800" : "text-slate-400 line-through"}`}>{a.name}</p>
                    <p className="text-[10px] text-slate-500">
                      {a.phone}
                      {a.city ? ` · ${a.city}` : ""} · {a.preferred_channel}
                    </p>
                  </div>
                  {canEdit && (
                    <button onClick={() => toggleActive(a)} disabled={busy} className="text-[10px] font-semibold text-slate-500 underline">
                      {a.active ? "Deactivate" : "Reactivate"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* Add */}
          {canEdit && (
            <div className="border-t border-slate-200 dark:border-slate-700 pt-2 space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Add agent</p>
              <div className="grid grid-cols-2 gap-2">
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Name *" className="text-xs border border-slate-300 rounded px-2 py-1" />
                <input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} placeholder="Phone *" className="text-xs border border-slate-300 rounded px-2 py-1" />
                <input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder="Email" className="text-xs border border-slate-300 rounded px-2 py-1" />
                <input value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} placeholder="City" className="text-xs border border-slate-300 rounded px-2 py-1" />
                <select value={draft.preferred_channel} onChange={(e) => setDraft({ ...draft, preferred_channel: e.target.value as typeof draft.preferred_channel })} className="text-xs border border-slate-300 rounded px-2 py-1">
                  <option value="email">Email</option>
                  <option value="sms">SMS</option>
                  <option value="whatsapp">WhatsApp</option>
                </select>
                <label className="text-xs border border-slate-300 rounded px-2 py-1 cursor-pointer text-slate-600 flex items-center">
                  {uploading ? "Uploading…" : draft.reference_photo_url ? "Reference ✓" : "Reference photo"}
                  <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && uploadRef(e.target.files[0])} />
                </label>
              </div>
              <button onClick={addAgent} disabled={busy || uploading} className="px-3 py-1.5 rounded-md bg-[color:var(--color-brand-navy)] text-white text-xs font-semibold disabled:opacity-50">
                Add agent
              </button>
            </div>
          )}

          {error && <p className="text-[11px] text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
