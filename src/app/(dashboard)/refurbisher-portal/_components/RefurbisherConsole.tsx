"use client";

/**
 * E-292 — the refurbisher partner's console (refurbish flow v3, steps 11–14).
 *
 * Small on purpose: the lots iTarang assigned to this partner, and for each
 * one — start work, cost every battery, record the truck back. No money, no
 * proforma invoice, no NBFC beyond a name: the API redacts all of that before
 * it reaches the browser (getLot(…, "refurbisher")).
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import RefurbLotDetail, {
  LotStatusChip,
  type LotAction,
  type LotView,
  type PhotoTarget,
} from "@/components/refurbishment/RefurbLotDetail";

const TABS = [
  { value: "open", label: "Open" },
  { value: "at_refurbisher", label: "To start" },
  { value: "in_progress", label: "In work" },
  { value: "costed", label: "Costed" },
  { value: "ready", label: "To dispatch" },
  { value: "in_transit_return", label: "On the way back" },
  { value: "all", label: "All" },
] as const;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    headers: init?.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok === false) {
    const raw = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(raw.replace(/^[A-Z_]+:\s*/, ""));
  }
  return body as T;
}

const dmy = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—");

export default function RefurbisherConsole({ initialLotId, compact = false }: { initialLotId?: string | null; compact?: boolean }) {
  const router = useRouter();
  const [tab, setTab] = useState<string>("open");
  const [rows, setRows] = useState<LotView[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(initialLotId ?? null);
  const [detail, setDetail] = useState<LotView | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items: LotView[]; counts: Record<string, number>; refurbisher: { id: string; name: string } }>(`/api/refurbisher/lots?status=${encodeURIComponent(tab)}`);
      setRows(r.items ?? []);
      setCounts(r.counts ?? {});
      setMe(r.refurbisher ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [tab]);
  useEffect(() => { void load(); }, [load]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const r = await api<{ lot: LotView }>(`/api/refurbisher/lots/${id}`);
      setDetail(r.lot);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    void loadDetail(openId);
  }, [openId, loadDetail]);

  async function act(action: LotAction, payload: Record<string, unknown>): Promise<unknown> {
    if (!detail) return;
    setBusy(true);
    setFlash(null);
    try {
      const r = await api<{ lot: LotView }>(`/api/refurbisher/lots/${detail.id}`, { method: "POST", body: JSON.stringify({ action, ...payload }) });
      setDetail(r.lot);
      const said: Partial<Record<LotAction, string>> = {
        "start-work": "Work started — cost each battery as you finish it.",
        "cost-item": r.lot.status === "costed" ? "Every battery is costed — iTarang will bill the NBFC and mark them ready." : "Cost recorded.",
        dispatch: "Return dispatch recorded — the NBFC will confirm receipt.",
        message: "Sent to iTarang.",
      };
      if (said[action]) setFlash(said[action] ?? null);
      await load();
      return r;
    } catch (e) {
      setFlash(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function upload(target: PhotoTarget, files: FileList): Promise<string[]> {
    if (!detail) return [];
    const form = new FormData();
    for (const f of Array.from(files)) form.append("file", f);
    form.append("target", target);
    try {
      const r = await api<{ paths: string[]; uploaded: number }>(`/api/refurbisher/lots/${detail.id}/photos`, { method: "POST", body: form });
      setFlash(`${r.uploaded} file(s) added`);
      return r.paths ?? [];
    } catch (e) {
      setFlash(e instanceof Error ? e.message : String(e));
      return [];
    }
  }

  const mine = rows.filter((r) => r.awaiting === "refurbisher").length;

  return (
    <div className="auction-sheet">
      {!compact ? (
        <header style={{ marginBlockEnd: "1.5rem" }}>
          <p className="auc-eyebrow">{me?.name ?? "Refurbisher"} · workshop</p>
          <h1 className="auc-h1">My lots</h1>
          <p className="auc-lede">Battery lots iTarang has assigned to you. Start work, record parts and your cost per battery, and record the truck back to the NBFC. iTarang handles everything else.</p>
        </header>
      ) : null}

      <div className="auc-kpis">
        <div className="auc-kpi" data-tone={mine > 0 ? "warn" : undefined}><b>{mine}</b><span>Waiting on you</span></div>
        <div className="auc-kpi"><b>{counts.at_refurbisher ?? 0}</b><span>To start</span></div>
        <div className="auc-kpi"><b>{counts.in_progress ?? 0}</b><span>In work</span></div>
        <div className="auc-kpi"><b>{counts.costed ?? 0}</b><span>Costed</span></div>
        <div className="auc-kpi" data-tone={(counts.ready ?? 0) > 0 ? "warn" : undefined}><b>{counts.ready ?? 0}</b><span>To dispatch</span></div>
      </div>

      <div className="auc-tabs" role="tablist" style={{ marginBlock: "1rem" }}>
        {TABS.map((t) => (
          <button key={t.value} type="button" role="tab" className="auc-tab" aria-selected={tab === t.value} onClick={() => setTab(t.value)}>{t.label}</button>
        ))}
      </div>

      {flash ? <p className="auc-lede" role="status" style={{ border: "1px solid var(--auc-rule)", padding: ".6rem .75rem" }}>{flash}</p> : null}

      {error ? (
        <p className="auc-lede">{error}</p>
      ) : loading ? (
        <p className="auc-lede">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="auc-empty"><p>No lots in this view</p><p className="auc-empty-hint">When iTarang assigns you a lot it appears here — an empty list is normal until then.</p></div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="auc-table">
            <thead><tr><th>Ref</th><th>From</th><th>Batteries</th><th>Status</th><th>Return by</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontFamily: "var(--font-mono, monospace)" }}>{r.ref_code}</td>
                  <td>{r.tenant_name ?? "—"}</td>
                  <td>{r.battery_count}</td>
                  <td><LotStatusChip status={r.status} /></td>
                  <td>{dmy(r.expected_return_date)}</td>
                  <td><button type="button" className="auc-btn" data-variant="ghost" onClick={() => { const next = r.id === openId ? null : r.id; setOpenId(next); if (!compact) router.replace(next ? `/refurbisher-portal/lots/${next}` : "/refurbisher-portal/lots"); }}>{r.id === openId ? "Close" : "Open"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail ? (
        <div style={{ marginBlockStart: "1rem" }}>
          <RefurbLotDetail lot={detail} side="refurbisher" canAct busy={busy} onAction={act} onUpload={upload} />
        </div>
      ) : null}
    </div>
  );
}
