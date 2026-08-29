"use client";

/**
 * The lot composer — BRD §7, §8, §13.
 *
 * WHAT THIS UNBLOCKS
 *   `composeLot()` and `publishLot()` have existed since E-234 with ZERO
 *   callers anywhere in the front end. The only way a lot came into being was a
 *   side effect of dragging a card on the recovery board, which silently
 *   created a one-battery DRAFT with a placeholder window — and nothing in the
 *   product could publish a draft. A recovery demo ran to that point and
 *   stopped. This screen is the missing half.
 *
 * FOUR PANELS, ONE FORM
 *   Basics → Items → Pricing → Window & visibility. On a wide screen all four
 *   are visible at once, because the price depends on the items and the reach
 *   depends on the window, and hiding either behind a "next" button makes the
 *   operator hold the relationship in their head. Below 60rem they become a
 *   stepped flow — the SAME panels with the others hidden, not a second
 *   component, so the two layouts cannot diverge.
 *
 * WHEN THE DRAFT IS WRITTEN
 *   Nothing is persisted until "Save draft" or "Publish". A new lot is one
 *   `POST /lots`; a resumed one is a `PATCH` plus an item reconcile. Publishing
 *   always saves first, so an operator cannot publish a lot that differs from
 *   the one on their screen.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { nbfcFetch, formatINR } from "@/lib/auction/client";
import { Eyebrow, SohBar, ConditionChip } from "@/components/auction/AuctionPrimitives";

// Mirrors of the server constants. Deliberately re-declared rather than
// imported: `composeLot.ts` pulls in the database client, and importing it into
// a client component drags the whole of drizzle into the browser bundle.
const DURATIONS = [2, 12, 24, 48] as const;
type Duration = (typeof DURATIONS)[number];

const SCOPES = ["india", "state", "city", "radius"] as const;
type Scope = (typeof SCOPES)[number];

const SCOPE_LABEL: Record<Scope, string> = {
  india: "All India",
  state: "States",
  city: "Cities",
  radius: "Radius",
};

interface LottableBattery {
  battery_id: string;
  serial: string;
  model: string | null;
  capacity: string | null;
  condition_grade: string | null;
  state_code: string;
  warehouse: string | null;
  city: string | null;
  state: string | null;
  image_url: string | null;
  photo_count: number;
  derived_price: number | null;
  soh: number | null;
}

interface LotSummary {
  lot_id: string;
  lot_code: string;
  title: string | null;
  status: string;
  quantity: number;
  base_price: number;
  bid_increment: number;
  reserve_price: number | null;
  auction_type: string;
  items: Array<{
    battery_id: string;
    serial: string;
    condition: string;
    item_price: number | null;
  }>;
}

interface AudiencePreview {
  dealer_count: number;
  resolved_centre: { lat: number; lng: number } | null;
  by_state: Array<{ state: string; count: number }>;
  nearest_km: number | null;
  farthest_km: number | null;
  without_city: number;
}

/** Splits a comma-separated field into trimmed, non-empty values. */
function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function LotComposer({ lotId }: { lotId?: string }) {
  const router = useRouter();
  const qc = useQueryClient();

  const [savedLotId, setSavedLotId] = useState<string | null>(lotId ?? null);
  const [step, setStep] = useState(0);

  // — panel 1: basics —
  const [title, setTitle] = useState("");
  const [auctionType, setAuctionType] = useState<"cash" | "cash_refinance">(
    "cash",
  );

  // — panel 2: items —
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  /** Item ids as they exist on the SAVED draft, for the reconcile on save. */
  const [persistedItems, setPersistedItems] = useState<string[]>([]);

  // — panel 3: pricing —
  const [basePrice, setBasePrice] = useState("");
  const [bidIncrement, setBidIncrement] = useState("");
  const [reservePrice, setReservePrice] = useState("");

  // — panel 4: window & visibility —
  const [duration, setDuration] = useState<Duration>(12);
  const [startMode, setStartMode] = useState<"now" | "schedule">("now");
  const [startsAt, setStartsAt] = useState("");
  const [scope, setScope] = useState<Scope>("india");
  const [statesRaw, setStatesRaw] = useState("");
  const [citiesRaw, setCitiesRaw] = useState("");
  const [centreCity, setCentreCity] = useState("");
  const [radiusKm, setRadiusKm] = useState("150");

  const [busy, setBusy] = useState<null | "save" | "publish" | "discard">(null);

  // ── data ────────────────────────────────────────────────────────────────
  const pickerQuery = useQuery({
    queryKey: ["auction", "nbfc", "lottable", search],
    queryFn: () =>
      nbfcFetch<{ items: LottableBattery[]; total: number }>(
        `/api/nbfc/auction/batteries/lottable${
          search ? `?q=${encodeURIComponent(search)}` : ""
        }`,
      ),
    staleTime: 10_000,
  });

  // A resumed draft. Its own batteries are `lotted`, so they are NOT in the
  // picker's list — they are merged in below, or the operator would open their
  // draft and find it empty.
  const draftQuery = useQuery({
    queryKey: ["auction", "nbfc", "lot", savedLotId],
    queryFn: () =>
      nbfcFetch<{ lot: LotSummary }>(`/api/nbfc/auction/lots/${savedLotId}`),
    enabled: Boolean(lotId),
  });

  const hydrated = useRef(false);
  useEffect(() => {
    const lot = draftQuery.data?.lot;
    if (!lot || hydrated.current) return;
    hydrated.current = true;
    setTitle(lot.title ?? "");
    setAuctionType(lot.auction_type === "cash_refinance" ? "cash_refinance" : "cash");
    setSelected(lot.items.map((i) => i.battery_id));
    setPersistedItems(lot.items.map((i) => i.battery_id));
    setBasePrice(String(lot.base_price));
    setBidIncrement(String(lot.bid_increment));
    setReservePrice(lot.reserve_price != null ? String(lot.reserve_price) : "");
  }, [draftQuery.data]);

  /** Picker rows plus any battery already on the draft. */
  const pickable: LottableBattery[] = useMemo(() => {
    const rows = pickerQuery.data?.items ?? [];
    const known = new Set(rows.map((r) => r.battery_id));
    const fromDraft = (draftQuery.data?.lot.items ?? [])
      .filter((i) => !known.has(i.battery_id))
      .map<LottableBattery>((i) => ({
        battery_id: i.battery_id,
        serial: i.serial,
        model: null,
        capacity: null,
        condition_grade: i.condition,
        state_code: "lotted",
        warehouse: null,
        city: null,
        state: null,
        image_url: null,
        photo_count: 0,
        derived_price: i.item_price,
        soh: null,
      }));
    return [...fromDraft, ...rows];
  }, [pickerQuery.data, draftQuery.data]);

  const selectedRows = useMemo(
    () => pickable.filter((b) => selected.includes(b.battery_id)),
    [pickable, selected],
  );

  // ── derived pricing ─────────────────────────────────────────────────────
  const derivedBase = useMemo(
    () => selectedRows.reduce((sum, b) => sum + (b.derived_price ?? 0), 0),
    [selectedRows],
  );
  const unpriced = selectedRows.filter((b) => b.derived_price == null).length;
  const effectiveBase = basePrice.trim() ? Number(basePrice) : derivedBase;
  const effectiveIncrement = bidIncrement.trim()
    ? Number(bidIncrement)
    : Math.max(100, Math.round((effectiveBase * 0.02) / 100) * 100);

  const conditionMix = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of selectedRows) {
      const k = b.condition_grade ?? "partial_working";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()];
  }, [selectedRows]);

  const avgSoh = useMemo(() => {
    const vals = selectedRows
      .map((b) => b.soh)
      .filter((s): s is number => s != null);
    return vals.length
      ? vals.reduce((a, b) => a + b, 0) / vals.length
      : null;
  }, [selectedRows]);

  // ── audience preview ────────────────────────────────────────────────────
  const [audience, setAudience] = useState<AudiencePreview | null>(null);
  const [audienceError, setAudienceError] = useState<string | null>(null);
  const [audienceBusy, setAudienceBusy] = useState(false);

  const visibilityBody = useMemo(() => {
    const body: Record<string, unknown> = { scope };
    if (scope === "state") body.states = splitList(statesRaw);
    if (scope === "city") body.cities = splitList(citiesRaw);
    if (scope === "radius") {
      body.centre_city = centreCity.trim() || undefined;
      body.radius_km = Number(radiusKm) || undefined;
    }
    return body;
  }, [scope, statesRaw, citiesRaw, centreCity, radiusKm]);

  // Debounced: the operator is typing city names, and one request per keystroke
  // would resolve the whole dealer table each time.
  useEffect(() => {
    const ready =
      scope === "india" ||
      (scope === "state" && splitList(statesRaw).length > 0) ||
      (scope === "city" && splitList(citiesRaw).length > 0) ||
      (scope === "radius" && centreCity.trim() !== "" && Number(radiusKm) > 0);

    if (!ready) {
      setAudience(null);
      setAudienceError(null);
      return;
    }

    let cancelled = false;
    const t = setTimeout(async () => {
      setAudienceBusy(true);
      setAudienceError(null);
      try {
        const r = await nbfcFetch<AudiencePreview>(
          "/api/nbfc/auction/audience/preview",
          { method: "POST", body: JSON.stringify(visibilityBody) },
        );
        if (!cancelled) setAudience(r);
      } catch (e) {
        if (!cancelled) {
          setAudience(null);
          setAudienceError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setAudienceBusy(false);
      }
    }, 450);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [visibilityBody, scope, statesRaw, citiesRaw, centreCity, radiusKm]);

  // ── actions ─────────────────────────────────────────────────────────────
  function toggle(id: string, disabled: boolean) {
    if (disabled) return;
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  /** Persists the draft and returns its id. Creates on first call. */
  async function persist(): Promise<string> {
    if (selected.length === 0) {
      throw new Error("Pick at least one battery before saving.");
    }

    if (!savedLotId) {
      const body: Record<string, unknown> = { battery_ids: selected };
      if (title.trim()) body.title = title.trim();
      if (auctionType !== "cash") body.auction_type = auctionType;
      if (basePrice.trim()) body.base_price = Number(basePrice);
      if (bidIncrement.trim()) body.bid_increment = Number(bidIncrement);
      if (reservePrice.trim()) body.reserve_price = Number(reservePrice);

      const r = await nbfcFetch<{ lot: LotSummary }>(
        "/api/nbfc/auction/lots",
        { method: "POST", body: JSON.stringify(body) },
      );
      setSavedLotId(r.lot.lot_id);
      setPersistedItems(r.lot.items.map((i) => i.battery_id));
      return r.lot.lot_id;
    }

    // Items first: adding or removing one re-derives the base price, so a
    // hand-set price has to be written AFTER, or the reconcile overwrites it.
    const toAdd = selected.filter((id) => !persistedItems.includes(id));
    const toRemove = persistedItems.filter((id) => !selected.includes(id));

    if (toAdd.length > 0) {
      await nbfcFetch(`/api/nbfc/auction/lots/${savedLotId}/items`, {
        method: "POST",
        body: JSON.stringify({ battery_ids: toAdd }),
      });
    }
    for (const id of toRemove) {
      await nbfcFetch(
        `/api/nbfc/auction/lots/${savedLotId}/items?battery_id=${id}`,
        { method: "DELETE" },
      );
    }
    setPersistedItems(selected);

    const patch: Record<string, unknown> = {
      title: title.trim() || null,
      auction_type: auctionType,
    };
    if (basePrice.trim()) patch.base_price = Number(basePrice);
    if (bidIncrement.trim()) patch.bid_increment = Number(bidIncrement);
    patch.reserve_price = reservePrice.trim() ? Number(reservePrice) : null;

    await nbfcFetch(`/api/nbfc/auction/lots/${savedLotId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });

    return savedLotId;
  }

  async function onSave() {
    setBusy("save");
    try {
      const id = await persist();
      qc.invalidateQueries({ queryKey: ["auction"] });
      toast.success("Draft saved");
      if (!lotId) router.replace(`/nbfc/auction/compose/${id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onPublish() {
    if (selected.length === 0) {
      toast.error("Pick at least one battery first.");
      return;
    }
    if (!audience || audience.dealer_count === 0) {
      toast.error(
        "This visibility rule reaches nobody — widen it before publishing.",
      );
      return;
    }

    const when =
      startMode === "now"
        ? "immediately"
        : `at ${new Date(startsAt).toLocaleString("en-IN")}`;
    const ok = await confirmDialog({
      title: "Publish this lot?",
      message:
        `${selected.length} batter${selected.length === 1 ? "y" : "ies"} · base ` +
        `${formatINR(effectiveBase)} · ${duration} h from ${when} · ` +
        `${audience.dealer_count} dealer${audience.dealer_count === 1 ? "" : "s"}.\n\n` +
        "Publishing freezes the audience: the dealers who can see this lot are " +
        "fixed at this moment and do not change afterwards.",
      confirmText: "Publish",
    });
    if (!ok) return;

    setBusy("publish");
    try {
      const id = await persist();

      const visibility: Record<string, unknown> = { scope };
      if (scope === "state") visibility.states = splitList(statesRaw);
      if (scope === "city") visibility.cities = splitList(citiesRaw);
      if (scope === "radius") {
        // The coordinates the preview resolved, so what is frozen is what was
        // shown — not a second lookup that could land somewhere else.
        if (!audience.resolved_centre) {
          throw new Error("Centre not resolved yet — wait for the reach count.");
        }
        visibility.centre_lat = audience.resolved_centre.lat;
        visibility.centre_lng = audience.resolved_centre.lng;
        visibility.radius_km = Number(radiusKm);
      }

      const body: Record<string, unknown> = {
        duration_hours: duration,
        visibility,
      };
      if (startMode === "schedule" && startsAt) {
        body.starts_at = new Date(startsAt).toISOString();
      }

      const r = await nbfcFetch<{
        lot_code: string;
        status: string;
        audience_dealers: number;
      }>(`/api/nbfc/auction/lots/${id}/publish`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      qc.invalidateQueries({ queryKey: ["auction"] });
      toast.success(
        `${r.lot_code} is ${r.status} — announced to ${r.audience_dealers} dealer${
          r.audience_dealers === 1 ? "" : "s"
        }`,
      );
      router.push(`/nbfc/auction/${id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onDiscard() {
    if (!savedLotId) {
      router.push("/nbfc/auction/drafts");
      return;
    }
    const ok = await confirmDialog({
      title: "Discard this draft?",
      message:
        "The lot is cancelled and every battery on it goes back to ready, " +
        "free to be listed again. This cannot be undone.",
      confirmText: "Discard",
      variant: "danger",
    });
    if (!ok) return;

    setBusy("discard");
    try {
      const r = await nbfcFetch<{ released: number }>(
        `/api/nbfc/auction/lots/${savedLotId}`,
        { method: "DELETE" },
      );
      qc.invalidateQueries({ queryKey: ["auction"] });
      toast.success(
        `Draft discarded — ${r.released} batter${r.released === 1 ? "y" : "ies"} released`,
      );
      router.push("/nbfc/auction/drafts");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // ── render ──────────────────────────────────────────────────────────────
  const panels = ["Basics", "Items", "Pricing", "Window"];

  return (
    <div className="auction-sheet">
      <div className="auc-sheet-head">
        <div>
          <h1 className="auc-h1">
            {savedLotId ? "Edit draft lot" : "Compose auction lot"}
          </h1>
          <p className="auc-lede">
            Pick the batteries, set the price, choose how long it runs and who
            can see it. Nothing is announced until you press Publish.
          </p>
        </div>
        {draftQuery.data?.lot ? (
          <div className="auc-head-actions">
            <span className="auc-lotcode">{draftQuery.data.lot.lot_code}</span>
          </div>
        ) : null}
      </div>

      {/* Step rail — only visible when the panels stack. */}
      <div className="auc-steps" role="tablist">
        {panels.map((p, i) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-current={step === i}
            onClick={() => setStep(i)}
          >
            {i + 1} · {p}
          </button>
        ))}
      </div>

      <div className="auc-wizard">
        {/* ── 1 · Basics ── */}
        <section className="auc-panel" data-active={step === 0}>
          <header>
            <span className="auc-panel-n">1</span>
            <h3>Basics</h3>
          </header>
          <div className="auc-panel-body">
            <div className="auc-field">
              <label htmlFor="lot-title">Lot title</label>
              <input
                id="lot-title"
                className="auc-text"
                value={title}
                maxLength={160}
                placeholder="5 × 48V refurbished — Kanpur hub"
                onChange={(e) => setTitle(e.target.value)}
              />
              <span className="auc-hint">
                What a dealer sees first. Leave it blank and the lot code is
                used instead.
              </span>
            </div>

            <div className="auc-field">
              <span className="auc-label">Auction type</span>
              <div className="auc-seg">
                <button
                  type="button"
                  aria-pressed={auctionType === "cash"}
                  onClick={() => setAuctionType("cash")}
                >
                  Cash
                </button>
                <button
                  type="button"
                  aria-pressed={auctionType === "cash_refinance"}
                  onClick={() => setAuctionType("cash_refinance")}
                >
                  Cash + refinance
                </button>
              </div>
              <span className="auc-hint">
                {auctionType === "cash"
                  ? "The winner pays in full on settlement."
                  : "The winner can finance the purchase — a sanction is raised against them when the settlement is created."}
              </span>
            </div>

            <div className="auc-field">
              <span className="auc-label">Seller</span>
              <div className="auc-ledger">
                <div className="auc-ledger-row">
                  <span>Your NBFC</span>
                  <b>locked</b>
                </div>
              </div>
              <span className="auc-hint">
                A lot always sells on behalf of the tenant that composed it.
              </span>
            </div>
          </div>
        </section>

        {/* ── 2 · Items ── */}
        <section className="auc-panel" data-active={step === 1}>
          <header>
            <span className="auc-panel-n">2</span>
            <h3>Items</h3>
            <span className="auc-count">{selected.length} selected</span>
          </header>
          <div className="auc-panel-body">
            <div className="auc-field">
              <label htmlFor="pick-search">Search ready stock</label>
              <input
                id="pick-search"
                className="auc-text"
                value={search}
                placeholder="serial, model, warehouse or city"
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {pickerQuery.isLoading ? (
              <div className="auc-stack">
                <div className="auc-skel" style={{ height: "3.25rem" }} />
                <div className="auc-skel" style={{ height: "3.25rem" }} />
                <div className="auc-skel" style={{ height: "3.25rem" }} />
              </div>
            ) : pickerQuery.isError ? (
              <div className="auc-inline-error">
                {(pickerQuery.error as Error).message}
              </div>
            ) : pickable.length === 0 ? (
              <div className="auc-empty">
                <p>No batteries ready to sell</p>
                <p className="auc-empty-hint">
                  A battery becomes lottable once it has been inspected — and
                  after refurbishment, once the workshop has returned it. Check
                  the recovery board for stock still waiting on a grade.
                </p>
              </div>
            ) : (
              <div className="auc-picker">
                {pickable.map((b) => {
                  const isSelected = selected.includes(b.battery_id);
                  const locked =
                    b.state_code === "lotted" && !persistedItems.includes(b.battery_id);
                  return (
                    <button
                      key={b.battery_id}
                      type="button"
                      className="auc-pick-row"
                      aria-pressed={isSelected}
                      disabled={locked}
                      onClick={() => toggle(b.battery_id, locked)}
                    >
                      <span className="auc-pick-box" aria-hidden="true">
                        {isSelected ? "✓" : ""}
                      </span>
                      <span className="auc-pick-main">
                        <span className="auc-pick-serial">{b.serial}</span>
                        <span className="auc-pick-meta">
                          <ConditionChip
                            condition={b.condition_grade ?? "partial_working"}
                          />
                          <SohBar soh={b.soh} />
                          {b.warehouse ? (
                            <span className="auc-subtle">{b.warehouse}</span>
                          ) : null}
                          {b.photo_count === 0 ? (
                            <span className="auc-chip" data-tone="warn">
                              no photos
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <span className="auc-pick-price">
                        {b.derived_price != null
                          ? formatINR(b.derived_price)
                          : "unpriced"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {selected.length > 0 ? (
              <div className="auc-ledger">
                <div className="auc-ledger-row">
                  <span>Condition mix</span>
                  <b>
                    {conditionMix
                      .map(([k, n]) => `${n} ${k.replace("_", " ")}`)
                      .join(" · ")}
                  </b>
                </div>
                <div className="auc-ledger-row">
                  <span>Average SOH</span>
                  <b>{avgSoh != null ? `${avgSoh.toFixed(1)} %` : "not graded"}</b>
                </div>
              </div>
            ) : null}

            <span className="auc-hint">
              A battery can sit on only one open lot at a time. Anything already
              on another lot — draft, scheduled, live or paused — is left out of
              this list until that lot ends or is cancelled.
            </span>
          </div>
        </section>

        {/* ── 3 · Pricing ── */}
        <section className="auc-panel" data-active={step === 2}>
          <header>
            <span className="auc-panel-n">3</span>
            <h3>Pricing</h3>
          </header>
          <div className="auc-panel-body">
            <div className="auc-ledger">
              <div className="auc-ledger-row">
                <span>{selected.length} item{selected.length === 1 ? "" : "s"}, evaluated</span>
                <b>{formatINR(derivedBase)}</b>
              </div>
              {unpriced > 0 ? (
                <div className="auc-ledger-row">
                  <span>Unpriced</span>
                  <b>{unpriced}</b>
                </div>
              ) : null}
              <div className="auc-ledger-row" data-total="true">
                <span>Opening price</span>
                <b>{formatINR(effectiveBase)}</b>
              </div>
            </div>

            {unpriced > 0 ? (
              <span className="auc-hint" data-tone="warn">
                {unpriced} of the selected batteries have no evaluation price
                and contribute nothing to the total. Grade them first, or set
                the base price by hand below.
              </span>
            ) : (
              <span className="auc-hint">
                Derived from each battery&apos;s latest evaluation plus what its
                refurbishment actually cost, accessories included — the dealer
                sees one number.
              </span>
            )}

            <div className="auc-field">
              <label htmlFor="base-price">Base price — override</label>
              <input
                id="base-price"
                className="auc-text"
                data-numeric="true"
                inputMode="numeric"
                value={basePrice}
                placeholder={String(derivedBase || "")}
                onChange={(e) => setBasePrice(e.target.value.replace(/[^\d.]/g, ""))}
              />
              <span className="auc-hint">
                Leave blank to use the derived figure. Changing the items resets
                an override, so set this once the list is settled.
              </span>
            </div>

            <div className="auc-field">
              <label htmlFor="increment">Bid increment</label>
              <input
                id="increment"
                className="auc-text"
                data-numeric="true"
                inputMode="numeric"
                value={bidIncrement}
                placeholder={String(effectiveIncrement)}
                onChange={(e) => setBidIncrement(e.target.value.replace(/[^\d.]/g, ""))}
              />
              <span className="auc-hint">
                Default is 2 % of base, rounded to ₹100.
              </span>
            </div>

            <div className="auc-field">
              <label htmlFor="reserve">Reserve price — optional</label>
              <input
                id="reserve"
                className="auc-text"
                data-numeric="true"
                data-invalid={
                  reservePrice.trim() !== "" &&
                  Number(reservePrice) < effectiveBase
                }
                inputMode="numeric"
                value={reservePrice}
                placeholder="none"
                onChange={(e) => setReservePrice(e.target.value.replace(/[^\d.]/g, ""))}
              />
              <span
                className="auc-hint"
                data-tone={
                  reservePrice.trim() !== "" && Number(reservePrice) < effectiveBase
                    ? "warn"
                    : undefined
                }
              >
                {reservePrice.trim() !== "" && Number(reservePrice) < effectiveBase
                  ? "A reserve below the base price can never bind — bidding opens at the base price."
                  : "Hidden from bidders. If the top bid is below it at close, no settlement is created and the batteries return to ready."}
              </span>
            </div>
          </div>
        </section>

        {/* ── 4 · Window & visibility ── */}
        <section className="auc-panel" data-active={step === 3}>
          <header>
            <span className="auc-panel-n">4</span>
            <h3>Window &amp; visibility</h3>
          </header>
          <div className="auc-panel-body">
            <div className="auc-field">
              <span className="auc-label">Duration</span>
              <div className="auc-seg">
                {DURATIONS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={duration === d}
                    onClick={() => setDuration(d)}
                  >
                    {d} h
                  </button>
                ))}
              </div>
              <span className="auc-hint">
                48 hours is the hard maximum, enforced on the server.
              </span>
            </div>

            <div className="auc-field">
              <span className="auc-label">Start</span>
              <div className="auc-seg">
                <button
                  type="button"
                  aria-pressed={startMode === "now"}
                  onClick={() => setStartMode("now")}
                >
                  Open now
                </button>
                <button
                  type="button"
                  aria-pressed={startMode === "schedule"}
                  onClick={() => setStartMode("schedule")}
                >
                  Schedule
                </button>
              </div>
              {startMode === "schedule" ? (
                <input
                  className="auc-text"
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                />
              ) : null}
            </div>

            <div className="auc-field">
              <span className="auc-label">Who can see it</span>
              <div className="auc-seg">
                {SCOPES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={scope === s}
                    onClick={() => setScope(s)}
                  >
                    {SCOPE_LABEL[s]}
                  </button>
                ))}
              </div>
            </div>

            {scope === "state" ? (
              <div className="auc-field">
                <label htmlFor="states">States</label>
                <input
                  id="states"
                  className="auc-text"
                  value={statesRaw}
                  placeholder="Uttar Pradesh, Bihar"
                  onChange={(e) => setStatesRaw(e.target.value)}
                />
                <span className="auc-hint">Comma separated.</span>
              </div>
            ) : null}

            {scope === "city" ? (
              <div className="auc-field">
                <label htmlFor="cities">Cities</label>
                <input
                  id="cities"
                  className="auc-text"
                  value={citiesRaw}
                  placeholder="Kanpur, Lucknow"
                  onChange={(e) => setCitiesRaw(e.target.value)}
                />
                <span className="auc-hint">
                  Comma separated. Dealers with no city on file are not reached
                  by a city rule.
                </span>
              </div>
            ) : null}

            {scope === "radius" ? (
              <>
                <div className="auc-field">
                  <label htmlFor="centre">Centre</label>
                  <input
                    id="centre"
                    className="auc-text"
                    value={centreCity}
                    placeholder="Kanpur"
                    onChange={(e) => setCentreCity(e.target.value)}
                  />
                </div>
                <div className="auc-field">
                  <label htmlFor="radius">Radius (km)</label>
                  <input
                    id="radius"
                    className="auc-text"
                    data-numeric="true"
                    inputMode="numeric"
                    value={radiusKm}
                    onChange={(e) => setRadiusKm(e.target.value.replace(/\D/g, ""))}
                  />
                  <span className="auc-hint">
                    Distance is measured to each dealer&apos;s city centre —
                    accounts carry no coordinates of their own.
                  </span>
                </div>
              </>
            ) : null}

            <div
              className="auc-reach"
              data-tone={
                audience && audience.dealer_count === 0 ? "warn" : undefined
              }
            >
              {audienceBusy ? (
                <b>Checking…</b>
              ) : audienceError ? (
                <>
                  <b>—</b>
                  <p>{audienceError}</p>
                </>
              ) : audience ? (
                <>
                  <b>
                    {audience.dealer_count} dealer
                    {audience.dealer_count === 1 ? "" : "s"}
                  </b>
                  <p>
                    {audience.dealer_count === 0
                      ? "Nobody matches this rule. Widen it, or check that your dealers have a city on file."
                      : audience.by_state
                          .slice(0, 4)
                          .map((s) => `${s.state} ${s.count}`)
                          .join(" · ")}
                    {audience.nearest_km != null
                      ? ` · nearest ${audience.nearest_km.toFixed(0)} km, farthest ${audience.farthest_km?.toFixed(0)} km`
                      : ""}
                  </p>
                </>
              ) : (
                <>
                  <b>—</b>
                  <p>
                    Choose a rule to see how many dealers it reaches. Active,
                    approved dealers only; NBFC users are excluded by role, so
                    the exclusion holds even inside the radius.
                  </p>
                </>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* Sticky commit bar. */}
      <div className="auc-commit">
        <div className="auc-commit-summary">
          <b>{selected.length}</b> batter{selected.length === 1 ? "y" : "ies"} ·
          base <b>{formatINR(effectiveBase)}</b> · +
          <b>{formatINR(effectiveIncrement)}</b> · <b>{duration} h</b> ·{" "}
          {SCOPE_LABEL[scope]}
          {audience ? (
            <>
              {" "}
              · reaches <b>{audience.dealer_count}</b>
            </>
          ) : null}
        </div>
        <div className="auc-commit-actions">
          <button
            type="button"
            className="auc-btn"
            data-variant="ghost"
            disabled={busy !== null}
            onClick={onDiscard}
          >
            {savedLotId ? "Discard draft" : "Cancel"}
          </button>
          <button
            type="button"
            className="auc-btn"
            data-variant="ghost"
            disabled={busy !== null || selected.length === 0}
            onClick={onSave}
          >
            {busy === "save" ? "Saving…" : "Save draft"}
          </button>
          <button
            type="button"
            className="auc-btn"
            disabled={busy !== null || selected.length === 0}
            onClick={onPublish}
          >
            {busy === "publish" ? "Publishing…" : "Publish lot"}
          </button>
        </div>
      </div>

      <div style={{ marginBlockStart: "1.5rem" }}>
        <Eyebrow>what happens when you publish</Eyebrow>
        <p className="auc-lede" style={{ marginBlockStart: "0.5rem" }}>
          The audience is resolved once and frozen — the dealers who can see
          this lot are fixed at that moment. Each of them is queued an in-app
          notification and an email, and the lot appears on their dashboard
          carousel. The scheduler opens it at the start time and closes it at
          the deadline, picking the highest bid and breaking ties by whoever
          bid first.
        </p>
      </div>
    </div>
  );
}
