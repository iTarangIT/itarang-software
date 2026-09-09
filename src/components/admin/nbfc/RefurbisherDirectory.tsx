"use client";

/**
 * E-292 — the refurbisher partner directory (refurbish flow v3, step 10).
 *
 * "Onboarded like recyclers (P Camp etc.); 1–2 partners to start." A short
 * form creates the partner and emails them a generated portal password. A
 * bounced email leaves the row in `credential_dispatch_failed` with a retry
 * button — the partner is real, only delivery failed.
 */
import { useCallback, useEffect, useState } from "react";

interface Refurbisher {
  id: string;
  name: string;
  contact_name: string | null;
  email: string;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  gstin: string | null;
  notes: string | null;
  is_active: boolean;
  credential_dispatch_status: string | null;
  credential_dispatched_at: string | null;
  credential_last_error: string | null;
  has_login: boolean;
  open_lots: number;
  created_at: string;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", headers: init?.body ? { "content-type": "application/json" } : undefined, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok === false) {
    const raw = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(raw.replace(/^[A-Z_]+:\s*/, ""));
  }
  return body as T;
}

const EMPTY = { name: "", contact_name: "", email: "", phone: "", address: "", city: "", state: "", gstin: "", notes: "" };

export default function RefurbisherDirectory() {
  const [rows, setRows] = useState<Refurbisher[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [issueLogin, setIssueLogin] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items: Refurbisher[] }>(`/api/admin/nbfc/refurbishers${showInactive ? "?include_inactive=1" : ""}`);
      setRows(r.items ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [showInactive]);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    setBusy("create");
    setFlash(null);
    try {
      const body: Record<string, unknown> = { name: form.name.trim(), email: form.email.trim(), issue_login: issueLogin };
      for (const k of ["contact_name", "phone", "address", "city", "state", "gstin", "notes"] as const) {
        const v = form[k].trim();
        if (v) body[k] = v;
      }
      const r = await api<{ refurbisher: Refurbisher; credential: { dispatched: boolean; dispatchedTo: string; error?: string } | null }>("/api/admin/nbfc/refurbishers", { method: "POST", body: JSON.stringify(body) });
      setFlash(
        !r.credential
          ? `${r.refurbisher.name} added (no login issued).`
          : r.credential.dispatched
            ? `${r.refurbisher.name} added — login emailed to ${r.credential.dispatchedTo}.`
            : `${r.refurbisher.name} added, but the credentials email failed: ${r.credential.error ?? "unknown error"}. Retry from the list.`,
      );
      setForm(EMPTY);
      setAdding(false);
      await load();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function resend(r: Refurbisher, force = false) {
    setBusy(r.id);
    setFlash(null);
    try {
      const res = await api<{ credential: { dispatched: boolean; dispatchedTo: string; error?: string } }>(`/api/admin/nbfc/refurbishers/${r.id}`, { method: "POST", body: JSON.stringify({ action: "resend-credentials", force }) });
      setFlash(res.credential.dispatched ? `Login emailed to ${res.credential.dispatchedTo}.` : `Email failed again: ${res.credential.error ?? "unknown error"}`);
      await load();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function toggleActive(r: Refurbisher) {
    setBusy(r.id);
    setFlash(null);
    try {
      await api(`/api/admin/nbfc/refurbishers/${r.id}`, { method: "PATCH", body: JSON.stringify({ is_active: !r.is_active }) });
      setFlash(r.is_active ? `${r.name} deactivated — their login is disabled and they cannot be assigned new lots.` : `${r.name} reactivated.`);
      await load();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const field = (k: keyof typeof EMPTY, label: string, placeholder = "") => (
    <div className="auc-field"><label>{label}</label><input className="auc-text" value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} placeholder={placeholder} /></div>
  );

  return (
    <div className="auction-sheet">
      <header style={{ marginBlockEnd: "1.5rem" }}>
        <p className="auc-eyebrow">NBFC · refurbishment</p>
        <h1 className="auc-h1">Refurbishers</h1>
        <p className="auc-lede">The partners who do the physical refurbishment (the P Camp model). iTarang assigns each lot to one of them from the Refurbishment Desk; they work it in their own portal. The NBFC never sees who.</p>
      </header>

      <div className="auc-toolbar">
        <label style={{ display: "flex", gap: ".4rem", alignItems: "center" }} className="auc-subtle"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> show deactivated</label>
        <div className="auc-toolbar-end"><button type="button" className="auc-btn" onClick={() => setAdding((v) => !v)}>{adding ? "Close" : "+ Add refurbisher"}</button></div>
      </div>

      {flash ? <p className="auc-lede" role="status" style={{ border: "1px solid var(--auc-rule)", padding: ".6rem .75rem" }}>{flash}</p> : null}

      {adding ? (
        <section className="auc-panel" style={{ marginBlockEnd: "1.5rem" }}>
          <header><span className="auc-panel-n">＋</span><h3>New refurbisher</h3></header>
          <div className="auc-panel-body">
            <div className="auc-dl" style={{ gap: ".75rem" }}>
              {field("name", "Business name", "e.g. P Camp Refurbishers")}
              {field("contact_name", "Contact person")}
              {field("email", "Email (login id)", "workshop@example.com")}
              {field("phone", "Phone")}
              {field("gstin", "GSTIN")}
              {field("city", "City")}
              {field("state", "State")}
              {field("address", "Workshop address")}
            </div>
            <div className="auc-field" style={{ marginBlockStart: ".5rem" }}><label>Notes</label><textarea className="auc-text" rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Capacity, chemistries, turnaround, terms." /></div>
            <label style={{ display: "flex", gap: ".4rem", alignItems: "center", marginBlockStart: ".5rem" }}><input type="checkbox" checked={issueLogin} onChange={(e) => setIssueLogin(e.target.checked)} /> Issue a portal login now (a generated password is emailed to them)</label>
            <div className="auc-linkrow" style={{ marginBlockStart: ".75rem" }}>
              <button type="button" className="auc-btn" disabled={busy === "create" || !form.name.trim() || !form.email.trim()} onClick={() => void create()}>{busy === "create" ? "Saving…" : "Add refurbisher"}</button>
              <button type="button" className="auc-btn" data-variant="ghost" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        </section>
      ) : null}

      {error ? <p className="auc-lede">{error}</p> : loading ? <p className="auc-lede">Loading…</p> : rows.length === 0 ? (
        <div className="auc-empty"><p>No refurbishers yet</p><p className="auc-empty-hint">Add the first partner above. A lot cannot be assigned until one exists.</p></div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="auc-table">
            <thead><tr><th>Refurbisher</th><th>Contact</th><th>Location</th><th>GSTIN</th><th>Login</th><th>Open lots</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={r.is_active ? undefined : { opacity: 0.6 }}>
                  <td><b>{r.name}</b>{!r.is_active ? <span className="auc-chip" data-tone="muted" style={{ marginInlineStart: ".4rem" }}>deactivated</span> : null}{r.notes ? <div className="auc-subtle">{r.notes}</div> : null}</td>
                  <td>{r.contact_name ?? "—"}<div className="auc-subtle">{r.email}{r.phone ? ` · ${r.phone}` : ""}</div></td>
                  <td>{[r.city, r.state].filter(Boolean).join(", ") || "—"}{r.address ? <div className="auc-subtle">{r.address}</div> : null}</td>
                  <td>{r.gstin ?? "—"}</td>
                  <td>
                    {r.credential_dispatch_status === "dispatched" && r.has_login ? <span className="auc-chip" data-tone="live">emailed {r.credential_dispatched_at ? new Date(r.credential_dispatched_at).toLocaleDateString("en-IN") : ""}</span>
                      : r.credential_dispatch_status === "credential_dispatch_failed" ? <><span className="auc-chip" data-tone="warn">email failed</span><div className="auc-subtle">{r.credential_last_error}</div></>
                      : r.has_login ? <span className="auc-chip">login exists</span>
                      : <span className="auc-chip" data-tone="muted">no login</span>}
                  </td>
                  <td className="auc-num">{r.open_lots}</td>
                  <td>
                    <div className="auc-linkrow">
                      {r.is_active && !(r.credential_dispatch_status === "dispatched" && r.has_login) ? <button type="button" className="auc-btn" data-variant="ghost" disabled={busy === r.id} onClick={() => void resend(r)}>{r.has_login ? "Re-send login" : "Issue login"}</button> : null}
                      {r.is_active && r.credential_dispatch_status === "dispatched" && r.has_login ? <button type="button" className="auc-btn" data-variant="ghost" disabled={busy === r.id} onClick={() => { if (confirm(`Reset ${r.name}'s password and email a new one?`)) void resend(r, true); }}>Reset password</button> : null}
                      <button type="button" className="auc-btn" data-variant={r.is_active ? "danger" : "ghost"} disabled={busy === r.id || (r.is_active && r.open_lots > 0)} title={r.is_active && r.open_lots > 0 ? "Has open lots — finish or re-assign them first" : undefined} onClick={() => void toggleActive(r)}>{r.is_active ? "Deactivate" : "Reactivate"}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
