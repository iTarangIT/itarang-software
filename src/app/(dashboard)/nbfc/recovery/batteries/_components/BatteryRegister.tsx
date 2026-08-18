"use client";

/**
 * The battery master — BRD §3.
 *
 * `recovery_batteries` arrived with E-232 as "the battery master this BRD asks
 * for": serial, model, capacity, condition, warehouse, coordinates, the source
 * loan, and the photographs the auction reuses. Its two routes shipped with no
 * screen at all, so the table could only ever be populated by curl — which is
 * why the recovery pipeline tracked serials as loose strings and the auction
 * gallery was always empty.
 *
 * This is intake: what arrived at the collection centre, and what state it is
 * in now.
 *
 * SHAPE OF THE SCREEN
 *   An NBFC operator opens this to answer two questions — how much stock do I
 *   hold, and which of it cannot be sold yet — so the tallies come first and
 *   the register second. On a wide screen the register is a ledger table:
 *   forty batteries scanned down a column of serials reads far faster than
 *   forty cards, and "awaiting photographs" is the column the eye is actually
 *   hunting for. Below 60rem the same rows become cards. Both are in the
 *   markup; `auc-only-wide` / `auc-only-narrow` show exactly one.
 */
import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { nbfcFetch } from "@/lib/auction/client";
import BatteryPhotoCapture from "@/components/nbfc-portal/BatteryPhotoCapture";
import { ConditionChip } from "@/components/auction/AuctionPrimitives";

interface Battery {
  id: string;
  serial: string;
  model: string | null;
  capacity: string | null;
  condition_grade: string | null;
  recovery_date: string | null;
  warehouse: string | null;
  city: string | null;
  state: string | null;
  image_urls: string[];
  state_code: string;
  notes: string | null;
  created_at: string;
}

interface Counts {
  total: number;
  awaiting_photos: number;
  by_state: Record<string, number>;
}

const STATES = [
  "all",
  "draft",
  "intaken",
  "inspected",
  "refurbishing",
  "ready",
  "lotted",
  "sold",
  "scrapped",
] as const;

const STATE_LABEL: Record<string, string> = {
  all: "All",
  draft: "Draft",
  intaken: "At centre",
  inspected: "Inspected",
  refurbishing: "In workshop",
  ready: "Ready to sell",
  lotted: "On a lot",
  sold: "Sold",
  scrapped: "Scrapped",
};

const TONE: Record<string, string> = {
  ready: "live",
  sold: "live",
  scrapped: "warn",
  lotted: "muted",
};

/** The five shots `BatteryPhotoCapture` asks for — front, back, side, serial
 *  plate, damage. The meter reads against that set, not against an arbitrary
 *  count, so "4 of 5" means one named angle is still missing. */
const REQUIRED_SHOTS = 5;

function PhotoMeter({ n }: { n: number }) {
  return (
    <span className="auc-pips" data-none={n === 0 ? "true" : undefined}>
      {Array.from({ length: REQUIRED_SHOTS }, (_, i) => (
        <i key={i} data-on={i < n ? "true" : undefined} />
      ))}
      <b>{n === 0 ? "none" : `${Math.min(n, REQUIRED_SHOTS)}/${REQUIRED_SHOTS}`}</b>
    </span>
  );
}

function Thumb({ b }: { b: Battery }) {
  const src = b.image_urls[0];
  if (!src) {
    return (
      <span className="auc-cell-thumb" data-empty="true" aria-hidden="true">
        —
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="auc-cell-thumb" src={src} alt="" loading="lazy" />;
}

export default function BatteryRegister() {
  const qc = useQueryClient();
  const [stateFilter, setStateFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [form, setForm] = useState({
    serial: "",
    model: "",
    capacity: "",
    warehouse: "",
    city: "",
    state: "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);

  const params = new URLSearchParams();
  if (stateFilter !== "all") params.set("state", stateFilter);
  if (search.trim()) params.set("q", search.trim());

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["auction", "nbfc", "batteries", stateFilter, search],
    queryFn: () =>
      nbfcFetch<{ items: Battery[]; total: number; counts?: Counts }>(
        `/api/nbfc/recovery/batteries?${params.toString()}`,
      ),
    refetchOnWindowFocus: true,
    // The tallies ride on every list response; holding the previous page's
    // data keeps the KPI strip and the tab counts from blinking to zero on
    // each keystroke in the search box.
    placeholderData: (prev) => prev,
  });

  async function register() {
    if (!form.serial.trim()) {
      toast.error("A serial number is required.");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = { serial: form.serial.trim() };
      // Only send what was filled in: the route body is `.strict()` and every
      // optional field has a min-length, so empty strings are a 400.
      for (const k of ["model", "capacity", "warehouse", "city", "state", "notes"] as const) {
        const v = form[k].trim();
        if (v) body[k] = v;
      }
      body.recovery_date = new Date().toISOString();

      const r = await nbfcFetch<{ battery: Battery; reused: boolean }>(
        "/api/nbfc/recovery/batteries",
        { method: "POST", body: JSON.stringify(body) },
      );
      toast.success(
        r.reused
          ? `${r.battery.serial} was already registered — re-intake recorded`
          : `${r.battery.serial} registered`,
      );
      setForm({
        serial: "",
        model: "",
        capacity: "",
        warehouse: "",
        city: "",
        state: "",
        notes: "",
      });
      setOpen(false);
      setExpanded(r.battery.id);
      qc.invalidateQueries({ queryKey: ["auction", "nbfc", "batteries"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const items = data?.items ?? [];
  const counts = data?.counts;
  const byState = counts?.by_state ?? {};
  const inWorkshop = byState.refurbishing ?? 0;
  const sellable = (byState.ready ?? 0) + (byState.lotted ?? 0);

  function toggle(id: string) {
    setExpanded((cur) => (cur === id ? null : id));
  }

  const photoPanel = (b: Battery) => (
    <BatteryPhotoCapture
      batteryId={b.id}
      initialUrls={b.image_urls}
      onChange={() =>
        qc.invalidateQueries({ queryKey: ["auction", "nbfc", "batteries"] })
      }
    />
  );

  return (
    <>
      {/* — the two questions the operator came here with — */}
      <div className="auc-kpis">
        <div className="auc-kpi">
          <b>{counts ? counts.total : "—"}</b>
          <span>Batteries held</span>
        </div>
        <div className="auc-kpi" data-tone="live">
          <b>{counts ? sellable : "—"}</b>
          <span>Sellable stock</span>
        </div>
        <div className="auc-kpi">
          <b>{counts ? inWorkshop : "—"}</b>
          <span>In workshop</span>
        </div>
        <div
          className="auc-kpi"
          data-tone={counts && counts.awaiting_photos > 0 ? "warn" : undefined}
        >
          <b>{counts ? counts.awaiting_photos : "—"}</b>
          <span>Awaiting photographs</span>
        </div>
      </div>

      {/* — state filter: tabs, not a dropdown. Nine states with live counts is
            a distribution the operator should be able to read at a glance,
            and a <select> hides eight of the nine. — */}
      <div className="auc-tabs" role="tablist" aria-label="Battery state">
        {STATES.map((s) => {
          const n = s === "all" ? counts?.total : byState[s];
          return (
            <button
              key={s}
              type="button"
              role="tab"
              className="auc-tab"
              aria-selected={stateFilter === s}
              onClick={() => setStateFilter(s)}
            >
              {STATE_LABEL[s]}
              {n !== undefined ? <em className="auc-tab-n">{n}</em> : null}
            </button>
          );
        })}
      </div>

      <div className="auc-toolbar">
        <div className="auc-field" style={{ flex: "1 1 16rem" }}>
          <label htmlFor="bat-search">Search</label>
          <input
            id="bat-search"
            className="auc-text"
            value={search}
            placeholder="serial or model"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="auc-toolbar-end">
          <button
            type="button"
            className="auc-btn"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Close" : "Register a battery"}
          </button>
        </div>
      </div>

      {open ? (
        <section className="auc-panel" style={{ marginBlockEnd: "1.5rem" }}>
          <header>
            <span className="auc-panel-n">＋</span>
            <h3>New intake</h3>
          </header>
          <div className="auc-panel-body">
            <div className="auc-field">
              <label htmlFor="f-serial">Serial number *</label>
              <input
                id="f-serial"
                className="auc-text"
                value={form.serial}
                maxLength={64}
                onChange={(e) => setForm({ ...form, serial: e.target.value })}
              />
              <span className="auc-hint">
                Unique across the platform. Re-registering a serial you already
                hold records a fresh intake rather than failing.
              </span>
            </div>

            <div className="auc-dl" style={{ gap: "0.875rem" }}>
              <div className="auc-field">
                <label htmlFor="f-model">Model</label>
                <input
                  id="f-model"
                  className="auc-text"
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                />
              </div>
              <div className="auc-field">
                <label htmlFor="f-capacity">Capacity</label>
                <input
                  id="f-capacity"
                  className="auc-text"
                  value={form.capacity}
                  placeholder="48V / 24Ah"
                  onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                />
              </div>
              <div className="auc-field">
                <label htmlFor="f-warehouse">Warehouse</label>
                <input
                  id="f-warehouse"
                  className="auc-text"
                  value={form.warehouse}
                  onChange={(e) =>
                    setForm({ ...form, warehouse: e.target.value })
                  }
                />
              </div>
              <div className="auc-field">
                <label htmlFor="f-city">City</label>
                <input
                  id="f-city"
                  className="auc-text"
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                />
              </div>
              <div className="auc-field">
                <label htmlFor="f-state">State</label>
                <input
                  id="f-state"
                  className="auc-text"
                  value={form.state}
                  onChange={(e) => setForm({ ...form, state: e.target.value })}
                />
              </div>
            </div>

            <div className="auc-field">
              <label htmlFor="f-notes">Notes</label>
              <textarea
                id="f-notes"
                className="auc-text"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </div>

            <span className="auc-hint">
              Photographs are added after the battery exists — open its row
              below, or capture them during inspection.
            </span>

            <div className="auc-linkrow">
              <button
                type="button"
                className="auc-btn"
                disabled={saving}
                onClick={register}
              >
                {saving ? "Registering…" : "Register"}
              </button>
              <button
                type="button"
                className="auc-btn"
                data-variant="ghost"
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {isLoading ? (
        <div className="auc-stack">
          {[0, 1, 2].map((i) => (
            <div key={i} className="auc-skel" style={{ height: "4.5rem" }} />
          ))}
        </div>
      ) : isError ? (
        <div className="auc-inline-error">{(error as Error).message}</div>
      ) : items.length === 0 ? (
        <div className="auc-empty">
          <p>No batteries {stateFilter === "all" ? "registered" : `in ${STATE_LABEL[stateFilter]}`}</p>
          <p className="auc-empty-hint">
            Register a battery when it arrives at the collection centre. Once
            inspected it becomes sellable, and its photographs travel with it
            all the way to the dealer&apos;s bidding screen.
          </p>
        </div>
      ) : (
        <>
          {/* — wide: the ledger — */}
          <div className="auc-only-wide auc-scroll-x">
            <table className="auc-table">
              <thead>
                <tr>
                  <th style={{ inlineSize: "3.5rem" }}>
                    <span className="auc-sr">Photo</span>
                  </th>
                  <th>Serial</th>
                  <th>Model</th>
                  <th>Capacity</th>
                  <th>Warehouse</th>
                  <th>Location</th>
                  <th>Photographs</th>
                  <th>State</th>
                  <th className="auc-num">Registered</th>
                  <th />
                </tr>
              </thead>
              {items.map((b) => (
                <tbody key={b.id}>
                  <tr>
                    <td>
                      <Thumb b={b} />
                    </td>
                    <td>
                      <div className="auc-winner">
                        <span className="auc-pick-serial">{b.serial}</span>
                        {b.condition_grade ? (
                          <ConditionChip condition={b.condition_grade} />
                        ) : null}
                      </div>
                    </td>
                    <td>{b.model ?? "—"}</td>
                    <td>{b.capacity ?? "—"}</td>
                    <td>{b.warehouse ?? "—"}</td>
                    <td>
                      {[b.city, b.state].filter(Boolean).join(", ") || "—"}
                    </td>
                    <td>
                      <PhotoMeter n={b.image_urls.length} />
                    </td>
                    <td>
                      <span
                        className="auc-chip"
                        data-tone={TONE[b.state_code] ?? undefined}
                      >
                        {STATE_LABEL[b.state_code] ?? b.state_code}
                      </span>
                    </td>
                    <td className="auc-num auc-subtle">
                      {new Date(b.created_at).toLocaleDateString("en-IN")}
                    </td>
                    <td>
                      <div className="auc-linkrow">
                        <button
                          type="button"
                          className="auc-btn"
                          data-variant="ghost"
                          aria-expanded={expanded === b.id}
                          onClick={() => toggle(b.id)}
                        >
                          {expanded === b.id ? "Hide" : "Photos"}
                        </button>
                        {b.state_code === "lotted" ? (
                          <Link
                            href="/nbfc/auction"
                            className="auc-btn"
                            data-variant="ghost"
                          >
                            Lot
                          </Link>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  {expanded === b.id ? (
                    <tr>
                      <td colSpan={10} style={{ padding: 0 }}>
                        <div className="auc-actions" data-open="true">
                          {photoPanel(b)}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              ))}
            </table>
          </div>

          {/* — narrow: the same rows as cards — */}
          <div className="auc-only-narrow">
            <div className="auc-stack">
            {items.map((b) => (
              <article key={b.id} className="auc-mini-card">
                <header>
                  <div className="auc-winner">
                    <span className="auc-pick-serial">{b.serial}</span>
                    {b.condition_grade ? (
                      <ConditionChip condition={b.condition_grade} />
                    ) : null}
                  </div>
                  <span
                    className="auc-chip"
                    data-tone={TONE[b.state_code] ?? undefined}
                  >
                    {STATE_LABEL[b.state_code] ?? b.state_code}
                  </span>
                </header>

                <div className="auc-card-lead">
                  <Thumb b={b} />
                  <dl className="auc-dl" style={{ flex: "1 1 0" }}>
                    <div>
                      <dt>Model</dt>
                      <dd>{b.model ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Capacity</dt>
                      <dd>{b.capacity ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Warehouse</dt>
                      <dd>{b.warehouse ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Location</dt>
                      <dd>
                        {[b.city, b.state].filter(Boolean).join(", ") || "—"}
                      </dd>
                    </div>
                    <div>
                      <dt>Photographs</dt>
                      <dd>
                        <PhotoMeter n={b.image_urls.length} />
                      </dd>
                    </div>
                    <div>
                      <dt>Registered</dt>
                      <dd className="auc-subtle">
                        {new Date(b.created_at).toLocaleDateString("en-IN")}
                      </dd>
                    </div>
                  </dl>
                </div>

                <div
                  className="auc-linkrow"
                  style={{ marginBlockStart: "0.75rem" }}
                >
                  <button
                    type="button"
                    className="auc-btn"
                    data-variant="ghost"
                    aria-expanded={expanded === b.id}
                    onClick={() => toggle(b.id)}
                  >
                    {expanded === b.id ? "Hide photos" : "Photographs"}
                  </button>
                  {b.state_code === "lotted" ? (
                    <Link
                      href="/nbfc/auction"
                      className="auc-btn"
                      data-variant="ghost"
                    >
                      View lot
                    </Link>
                  ) : null}
                </div>

                {expanded === b.id ? (
                  <div style={{ marginBlockStart: "0.875rem" }}>
                    {photoPanel(b)}
                  </div>
                ) : null}
              </article>
            ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
