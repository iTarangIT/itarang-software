"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  computeTotals,
  formatLastSaved,
  normKey,
  paraKey,
  productClass,
  totalsFromPrior,
} from "./pricing";
import type {
  AgeFilter,
  BatteryRow,
  CartTotals,
  ChargerRow,
  MarginMode,
  ParaRow,
  PriorSelection,
  ProductSelectionPayload,
  ScopeProduct,
} from "./types";

/**
 * The product cart controller.
 *
 * Owns the selection state, the inventory fetching, the filter/search/paging
 * chrome and the pricing math that used to live inline in the Step-4 page. It
 * is a hook rather than a `<ProductPicker value onChange>` component on
 * purpose: both host pages need ~20 derived values back out for their submit
 * payloads, and a value/onChange child would force the parent to mirror state
 * the child also holds — an echo loop on every margin keystroke. As a hook the
 * caller simply reads what it needs.
 *
 * Rendering is left entirely to the caller (`ProductCartSections` +
 * `CartPricingSummary`) so Step 4 and Step 5 can lay the cards out in their
 * own grids.
 */

// Cards per page for battery / charger lists. Above this count we paginate
// (search + filter chips remain global). Tuned for the 2-column md grid.
export const PAGE_SIZE = 12;

export const draftKey = (prefix: string, leadId: string) => `${prefix}-${leadId}`;

export interface ProductCartContext {
  leadId: string;
  dealerId: string | null;
  /** productCategories UUID, or a legacy slug. Drives the inventory queries. */
  category: string | null;
  /** Narrows the cards to these product types. `[]` ⇒ no narrowing. */
  scopeProducts: ScopeProduct[];
  /** product_selections snapshot. Hydrates the cart and backs the read-only pricing. */
  prior: PriorSelection | null;
  /** Disables every control and shows the submitted snapshot instead of live math. */
  readOnly: boolean;
  /**
   * Serials to keep visible even when inventory has them reserved. Needed for
   * leads submitted before the Step-4/Step-5 split, whose stock was reserved
   * at Step-4 submit and would otherwise vanish from the picker.
   */
  includeSerials?: { battery?: string | null; charger?: string | null };
  /** localStorage namespace — keeps the Step-4 and Step-5 drafts apart. */
  draftKeyPrefix: string;
  onError?: (message: string) => void;
}

export interface ListState<T> {
  scoped: T[];
  filtered: T[];
  paginated: T[];
  filter: AgeFilter;
  setFilter: (f: AgeFilter) => void;
  search: string;
  setSearch: (s: string) => void;
  page: number;
  pageCount: number;
  pageSize: number;
  setPage: (n: number) => void;
  loading: boolean;
  recommendedCount: number;
  ageingCount: number;
  oldCount: number;
}

export interface ProductCart {
  batteries: BatteryRow[];
  chargers: ChargerRow[];
  paraphernalia: ParaRow[];
  reload: () => Promise<void>;

  selectedBattery: BatteryRow | null;
  selectedCharger: ChargerRow | null;
  paraQty: Record<string, number>;
  batteryPhotoUrls: string[];
  chargerPhotoUrls: string[];

  setSelectedBattery: (b: BatteryRow | null) => void;
  setSelectedCharger: (c: ChargerRow | null) => void;
  setParaQty: (key: string, n: number, max: number) => void;
  /** Clears battery + charger + quantities. Step 4 calls this on category change. */
  resetSelection: () => void;

  uploadPhoto: (kind: "battery" | "charger", label: string, file: File) => Promise<void>;
  removePhoto: (kind: "battery" | "charger", idx: number) => void;
  photoUploading: string | null;
  photoError: string | null;

  batteryList: ListState<BatteryRow>;
  chargerList: ListState<ChargerRow>;
  scopedParaphernalia: ParaRow[];

  marginMode: MarginMode;
  marginInput: string;
  marginPercentInput: string;
  setMarginInput: (raw: string) => void;
  setMarginPercentInput: (raw: string) => void;
  setMarginMode: (next: MarginMode) => void;

  /** Always the live math — this is what gets submitted. */
  live: CartTotals;
  /** What the Pricing card should render (falls back to the saved snapshot). */
  display: CartTotals;

  toSubmitPayload: () => ProductSelectionPayload;
  saveLocalDraft: () => string;
  clearLocalDraft: () => void;
  readOnly: boolean;
  hydrated: boolean;
  lastSaved: string | null;
  setLastSaved: (v: string | null) => void;
}

export function useProductCart(ctx: ProductCartContext): ProductCart {
  const { leadId, dealerId, category, prior, readOnly, draftKeyPrefix } = ctx;
  const onError = ctx.onError;
  const includeBattery = ctx.includeSerials?.battery ?? null;
  const includeCharger = ctx.includeSerials?.charger ?? null;

  const [batteries, setBatteries] = useState<BatteryRow[]>([]);
  const [chargers, setChargers] = useState<ChargerRow[]>([]);
  const [paraphernalia, setParaphernalia] = useState<ParaRow[]>([]);

  const [selectedBattery, setSelectedBattery] = useState<BatteryRow | null>(null);
  const [selectedCharger, setSelectedCharger] = useState<ChargerRow | null>(null);
  const [paraQty, setParaQtyState] = useState<Record<string, number>>({});

  // Dealer margin can be entered as flat rupees OR as a % of the net subtotal.
  // The rupee value is derived so the two inputs stay in sync with the cart.
  const [marginMode, setMarginModeState] = useState<MarginMode>("rupees");
  const [marginInput, setMarginInput] = useState<string>("0");
  const [marginPercentInput, setMarginPercentInput] = useState<string>("0");

  const [batteryFilter, setBatteryFilter] = useState<AgeFilter>("all");
  const [chargerFilter, setChargerFilter] = useState<AgeFilter>("all");
  const [batterySearch, setBatterySearch] = useState("");
  const [chargerSearch, setChargerSearch] = useState("");
  const deferredBatterySearch = useDeferredValue(batterySearch);
  const deferredChargerSearch = useDeferredValue(chargerSearch);
  const [batteryPage, setBatteryPage] = useState(1);
  const [chargerPage, setChargerPage] = useState(1);
  const [batteriesLoading, setBatteriesLoading] = useState(false);
  const [chargersLoading, setChargersLoading] = useState(false);

  const [batteryPhotoUrls, setBatteryPhotoUrls] = useState<string[]>([]);
  const [chargerPhotoUrls, setChargerPhotoUrls] = useState<string[]>([]);
  const [photoUploading, setPhotoUploading] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Split rehydration guards. The Step-4 page used a single ref gated on the
  // battery list being non-empty, which meant margin, quantities and photos
  // never restored when inventory came back empty — precisely the case for a
  // lead whose stock is already reserved.
  const scalarsRestoredRef = useRef(false);
  const batteryRestoredRef = useRef(false);
  const chargerRestoredRef = useRef(false);

  const storageKey = draftKey(draftKeyPrefix, leadId);

  // ── Inventory ───────────────────────────────────────────────────────
  const reload = useCallback(async () => {
    if (!dealerId) return;
    setBatteriesLoading(true);
    try {
      const batQs = new URLSearchParams();
      if (category) batQs.set("category", category);
      if (includeBattery) batQs.set("includeSerials", includeBattery);
      const paraQs = new URLSearchParams();
      if (category) paraQs.set("category", category);

      const [batRes, paraRes] = await Promise.all([
        fetch(`/api/inventory/dealer/${dealerId}/batteries?${batQs.toString()}`),
        fetch(`/api/inventory/dealer/${dealerId}/paraphernalia?${paraQs.toString()}`),
      ]);
      const batJson = await batRes.json();
      const paraJson = await paraRes.json();
      if (batJson.success) setBatteries(batJson.data || []);
      if (paraJson.success) setParaphernalia(paraJson.data || []);
    } catch {
      onError?.("Failed to load inventory");
    } finally {
      setBatteriesLoading(false);
    }
  }, [dealerId, category, includeBattery, onError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Chargers depend on the selected battery's voltage.
  useEffect(() => {
    if (!dealerId || !selectedBattery) {
      setChargers([]);
      setSelectedCharger(null);
      return;
    }
    let cancelled = false;
    setChargersLoading(true);
    (async () => {
      try {
        const qs = new URLSearchParams();
        if (category) qs.set("category", category);
        if (selectedBattery.voltage_v) {
          qs.set("batteryVoltage", String(selectedBattery.voltage_v));
        }
        if (includeCharger) qs.set("includeSerials", includeCharger);
        const res = await fetch(`/api/inventory/dealer/${dealerId}/chargers?${qs.toString()}`);
        const json = await res.json();
        if (cancelled) return;
        if (json.success) setChargers(json.data || []);
      } catch {
        if (!cancelled) onError?.("Failed to load chargers");
      } finally {
        if (!cancelled) setChargersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dealerId, selectedBattery, category, includeCharger, onError]);

  // ── Rehydration A: scalars. Gated only on the prior/draft being readable,
  //    never on inventory, so margin and quantities always come back.
  useEffect(() => {
    if (scalarsRestoredRef.current) return;
    try {
      if (prior) {
        const para = prior.paraphernalia as Record<string, number | string> | null;
        if (para && typeof para === "object") {
          const normalised: Record<string, number> = {};
          for (const [k, v] of Object.entries(para)) {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) normalised[k] = n;
          }
          if (Object.keys(normalised).length > 0) setParaQtyState(normalised);
        }
        if (prior.dealer_margin) {
          setMarginModeState("rupees");
          setMarginInput(String(prior.dealer_margin));
        }
        if (Array.isArray(prior.battery_photo_urls)) {
          setBatteryPhotoUrls(prior.battery_photo_urls);
        }
        if (Array.isArray(prior.charger_photo_urls)) {
          setChargerPhotoUrls(prior.charger_photo_urls);
        }
        if (prior.submitted_at) {
          setLastSaved(formatLastSaved(new Date(prior.submitted_at)));
        }
        scalarsRestoredRef.current = true;
        setHydrated(true);
        return;
      }

      const raw = localStorage.getItem(storageKey);
      if (!raw) {
        scalarsRestoredRef.current = true;
        setHydrated(true);
        return;
      }
      const draft = JSON.parse(raw) as {
        paraQty?: Record<string, number>;
        dealerMargin?: number;
        marginMode?: MarginMode;
        marginInput?: string;
        marginPercentInput?: string;
        savedAt?: string;
      };
      if (draft.paraQty) setParaQtyState(draft.paraQty);
      if (draft.marginMode === "percent" || draft.marginMode === "rupees") {
        setMarginModeState(draft.marginMode);
      }
      if (typeof draft.marginInput === "string") {
        setMarginInput(draft.marginInput);
      } else if (typeof draft.dealerMargin === "number") {
        // legacy drafts (rupees-only)
        setMarginInput(String(draft.dealerMargin));
      }
      if (typeof draft.marginPercentInput === "string") {
        setMarginPercentInput(draft.marginPercentInput);
      }
      if (draft.savedAt) setLastSaved(formatLastSaved(new Date(draft.savedAt)));
    } catch {
      // ignore corrupted draft
    } finally {
      scalarsRestoredRef.current = true;
      setHydrated(true);
    }
  }, [prior, storageKey]);

  // ── Rehydration B: resolve the battery serial once inventory arrives.
  useEffect(() => {
    if (batteryRestoredRef.current) return;
    if (!batteries.length) return;
    try {
      let serial = prior?.battery_serial ?? null;
      if (!serial) {
        const raw = localStorage.getItem(storageKey);
        if (raw) serial = (JSON.parse(raw) as { batterySerial?: string }).batterySerial ?? null;
      }
      if (serial) {
        const b = batteries.find((x) => x.serial_number === serial);
        if (b) setSelectedBattery(b);
      }
    } catch {
      // ignore
    } finally {
      batteryRestoredRef.current = true;
    }
  }, [batteries, prior, storageKey]);

  // ── Rehydration C: same for the charger, which only loads after a battery.
  useEffect(() => {
    if (chargerRestoredRef.current) return;
    if (!chargers.length) return;
    try {
      let serial = prior?.charger_serial ?? null;
      if (!serial) {
        const raw = localStorage.getItem(storageKey);
        if (raw) serial = (JSON.parse(raw) as { chargerSerial?: string }).chargerSerial ?? null;
      }
      if (serial) {
        const c = chargers.find((x) => x.serial_number === serial);
        if (c) setSelectedCharger(c);
      }
    } catch {
      // ignore
    } finally {
      chargerRestoredRef.current = true;
    }
  }, [chargers, prior, storageKey]);

  // ── Product-type scope ──────────────────────────────────────────────
  const scope = useMemo(() => {
    const batterySkus = new Set<string>();
    const chargerSkus = new Set<string>();
    const batteryProductIds = new Set<string>();
    const chargerProductIds = new Set<string>();
    const paraTypes = new Set<string>();
    for (const p of ctx.scopeProducts) {
      const cls = productClass(p.asset_type);
      if (cls === "battery") {
        batterySkus.add(normKey(p.sku));
        batteryProductIds.add(p.id);
      } else if (cls === "charger") {
        chargerSkus.add(normKey(p.sku));
        chargerProductIds.add(p.id);
      } else {
        paraTypes.add(normKey(p.asset_type));
      }
    }
    return { batterySkus, chargerSkus, batteryProductIds, chargerProductIds, paraTypes };
  }, [ctx.scopeProducts]);

  const scopedBatteries = useMemo(
    () =>
      scope.batterySkus.size === 0 && scope.batteryProductIds.size === 0
        ? batteries
        : batteries.filter(
            (b) =>
              (b.product_id != null && scope.batteryProductIds.has(b.product_id)) ||
              scope.batterySkus.has(normKey(b.model_type)),
          ),
    [batteries, scope],
  );
  const scopedChargers = useMemo(
    () =>
      scope.chargerSkus.size === 0 && scope.chargerProductIds.size === 0
        ? chargers
        : chargers.filter(
            (c) =>
              (c.product_id != null && scope.chargerProductIds.has(c.product_id)) ||
              scope.chargerSkus.has(normKey(c.model_type)),
          ),
    [chargers, scope],
  );
  const scopedParaphernalia = useMemo(
    () =>
      scope.paraTypes.size === 0
        ? paraphernalia
        : paraphernalia.filter((p) => scope.paraTypes.has(normKey(p.asset_type))),
    [paraphernalia, scope],
  );

  // ── Filtering + paging ──────────────────────────────────────────────
  const filteredBatteries = useMemo(
    () => applyFilter(scopedBatteries, batteryFilter, deferredBatterySearch),
    [scopedBatteries, batteryFilter, deferredBatterySearch],
  );
  const filteredChargers = useMemo(
    () => applyFilter(scopedChargers, chargerFilter, deferredChargerSearch),
    [scopedChargers, chargerFilter, deferredChargerSearch],
  );

  const batteryPageCount = Math.max(1, Math.ceil(filteredBatteries.length / PAGE_SIZE));
  const chargerPageCount = Math.max(1, Math.ceil(filteredChargers.length / PAGE_SIZE));
  const safeBatteryPage = Math.min(batteryPage, batteryPageCount);
  const safeChargerPage = Math.min(chargerPage, chargerPageCount);

  const paginatedBatteries = useMemo(
    () =>
      filteredBatteries.slice((safeBatteryPage - 1) * PAGE_SIZE, safeBatteryPage * PAGE_SIZE),
    [filteredBatteries, safeBatteryPage],
  );
  const paginatedChargers = useMemo(
    () =>
      filteredChargers.slice((safeChargerPage - 1) * PAGE_SIZE, safeChargerPage * PAGE_SIZE),
    [filteredChargers, safeChargerPage],
  );

  // Reset to page 1 when filters/search change or the list reloads.
  useEffect(() => {
    setBatteryPage(1);
  }, [batteryFilter, deferredBatterySearch, scopedBatteries.length]);
  useEffect(() => {
    setChargerPage(1);
  }, [chargerFilter, deferredChargerSearch, scopedChargers.length]);

  // Drop a pick the active product-type scope excludes.
  useEffect(() => {
    if (
      (scope.batterySkus.size > 0 || scope.batteryProductIds.size > 0) &&
      selectedBattery &&
      !scopedBatteries.some((b) => b.id === selectedBattery.id)
    ) {
      setSelectedBattery(null);
    }
  }, [scopedBatteries, scope, selectedBattery]);
  useEffect(() => {
    if (
      (scope.chargerSkus.size > 0 || scope.chargerProductIds.size > 0) &&
      selectedCharger &&
      !scopedChargers.some((c) => c.id === selectedCharger.id)
    ) {
      setSelectedCharger(null);
    }
  }, [scopedChargers, scope, selectedCharger]);

  // ── Pricing ─────────────────────────────────────────────────────────
  const live = useMemo(
    () =>
      computeTotals({
        battery: selectedBattery,
        charger: selectedCharger,
        paraphernalia,
        paraQty,
        marginMode,
        marginInput,
        marginPercentInput,
      }),
    [
      selectedBattery,
      selectedCharger,
      paraphernalia,
      paraQty,
      marginMode,
      marginInput,
      marginPercentInput,
    ],
  );

  // Fall back to the saved snapshot whenever there is nothing live to price.
  // Broader than the old `readOnly && prior` rule on purpose: an editable page
  // whose inventory has not loaded yet would otherwise flash ₹0 across the
  // Pricing card where it used to show the real submitted total.
  const display = useMemo(
    () => (prior && (readOnly || !selectedBattery) ? totalsFromPrior(prior) : live),
    [prior, readOnly, selectedBattery, live],
  );

  // ── Mutators ────────────────────────────────────────────────────────
  const setParaQty = useCallback((key: string, n: number, max: number) => {
    setParaQtyState((prev) => ({ ...prev, [key]: Math.max(0, Math.min(max, n)) }));
  }, []);

  const resetSelection = useCallback(() => {
    setSelectedBattery(null);
    setSelectedCharger(null);
    setParaQtyState({});
  }, []);

  const setMarginMode = useCallback(
    (next: MarginMode) => {
      setMarginModeState((current) => {
        if (current === next) return current;
        // Convert so the rupee value the dealer is looking at survives the flip.
        if (next === "percent") {
          const rupees = parseFloat(marginInput);
          const pct =
            Number.isFinite(rupees) && rupees > 0 && live.netSubtotal > 0
              ? ((rupees / live.netSubtotal) * 100).toFixed(2)
              : "0";
          setMarginPercentInput(pct);
        } else {
          setMarginInput(String(live.dealerMargin || 0));
        }
        return next;
      });
    },
    [marginInput, live.netSubtotal, live.dealerMargin],
  );

  const uploadPhoto = useCallback(
    async (kind: "battery" | "charger", label: string, file: File) => {
      setPhotoError(null);
      setPhotoUploading(`${kind}:${label}`);
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("kind", kind);
        fd.append("label", label);
        const res = await fetch(`/api/lead/${leadId}/product-photo`, {
          method: "POST",
          body: fd,
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error?.message || "Upload failed");
        }
        const url = json.data.url as string;
        if (kind === "battery") setBatteryPhotoUrls((prev) => [...prev, url]);
        else setChargerPhotoUrls((prev) => [...prev, url]);
      } catch (err: unknown) {
        setPhotoError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setPhotoUploading(null);
      }
    },
    [leadId],
  );

  const removePhoto = useCallback((kind: "battery" | "charger", idx: number) => {
    const setter = kind === "battery" ? setBatteryPhotoUrls : setChargerPhotoUrls;
    setter((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const toSubmitPayload = useCallback((): ProductSelectionPayload => {
    const paramMap: Record<string, number> = {};
    paraphernalia.forEach((p) => {
      const k = paraKey(p);
      if (paraQty[k] > 0) paramMap[k] = paraQty[k];
    });
    // An untouched cart submits as NULL, not as a row of zeros — see
    // ProductSelectionPayload. This is the normal state of a finance lead at
    // Step 4, which goes to its lenders before any stock is picked.
    const empty =
      !selectedBattery && !selectedCharger && Object.keys(paramMap).length === 0;
    if (empty) {
      return {
        batterySerial: null,
        chargerSerial: null,
        paraphernalia: {},
        paraphernaliaLines: [],
        batteryPhotoUrls,
        chargerPhotoUrls,
      };
    }

    return {
      batterySerial: selectedBattery?.serial_number ?? null,
      chargerSerial: selectedCharger?.serial_number ?? null,
      paraphernalia: paramMap,
      paraphernaliaLines: live.paraLines,
      batteryPrice: live.batteryPrice,
      chargerPrice: live.chargerPrice,
      paraphernaliaCost: live.paraCost,
      dealerMargin: Number(live.dealerMargin || 0),
      dealerMarginGstPercent: live.dealerMarginGstPct,
      dealerMarginGstAmount: live.dealerMarginGst,
      finalPrice: live.finalPrice,
      batteryGross: live.batteryTriple.gross,
      batteryGstPercent: live.batteryTriple.gstPct,
      batteryGstAmount: live.batteryTriple.gst,
      batteryNet: live.batteryTriple.net,
      chargerGross: live.chargerTriple.gross,
      chargerGstPercent: live.chargerTriple.gstPct,
      chargerGstAmount: live.chargerTriple.gst,
      chargerNet: live.chargerTriple.net,
      grossSubtotal: live.grossSubtotal,
      gstSubtotal: live.gstSubtotal,
      netSubtotal: live.netSubtotal,
      batteryPhotoUrls,
      chargerPhotoUrls,
    };
  }, [
    paraphernalia,
    paraQty,
    selectedBattery,
    selectedCharger,
    live,
    batteryPhotoUrls,
    chargerPhotoUrls,
  ]);

  const saveLocalDraft = useCallback(() => {
    const stamp = formatLastSaved(new Date());
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          batterySerial: selectedBattery?.serial_number ?? null,
          chargerSerial: selectedCharger?.serial_number ?? null,
          paraQty,
          dealerMargin: live.dealerMargin,
          marginMode,
          marginInput,
          marginPercentInput,
          savedAt: new Date().toISOString(),
        }),
      );
    } catch {
      // ignore storage quota / private-mode errors
    }
    setLastSaved(stamp);
    return stamp;
  }, [
    storageKey,
    selectedBattery,
    selectedCharger,
    paraQty,
    live.dealerMargin,
    marginMode,
    marginInput,
    marginPercentInput,
  ]);

  const clearLocalDraft = useCallback(() => {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
  }, [storageKey]);

  return {
    batteries,
    chargers,
    paraphernalia,
    reload,

    selectedBattery,
    selectedCharger,
    paraQty,
    batteryPhotoUrls,
    chargerPhotoUrls,

    setSelectedBattery,
    setSelectedCharger,
    setParaQty,
    resetSelection,

    uploadPhoto,
    removePhoto,
    photoUploading,
    photoError,

    batteryList: {
      scoped: scopedBatteries,
      filtered: filteredBatteries,
      paginated: paginatedBatteries,
      filter: batteryFilter,
      setFilter: setBatteryFilter,
      search: batterySearch,
      setSearch: setBatterySearch,
      page: safeBatteryPage,
      pageCount: batteryPageCount,
      pageSize: PAGE_SIZE,
      setPage: setBatteryPage,
      loading: batteriesLoading,
      recommendedCount: scopedBatteries.filter((b) => b.recommended).length,
      ageingCount: scopedBatteries.filter((b) => b.age_badge === "ageing").length,
      oldCount: scopedBatteries.filter((b) => b.age_badge === "old").length,
    },
    chargerList: {
      scoped: scopedChargers,
      filtered: filteredChargers,
      paginated: paginatedChargers,
      filter: chargerFilter,
      setFilter: setChargerFilter,
      search: chargerSearch,
      setSearch: setChargerSearch,
      page: safeChargerPage,
      pageCount: chargerPageCount,
      pageSize: PAGE_SIZE,
      setPage: setChargerPage,
      loading: chargersLoading,
      recommendedCount: scopedChargers.filter((c) => c.recommended).length,
      ageingCount: scopedChargers.filter((c) => c.age_badge === "ageing").length,
      oldCount: scopedChargers.filter((c) => c.age_badge === "old").length,
    },
    scopedParaphernalia,

    marginMode,
    marginInput,
    marginPercentInput,
    setMarginInput,
    setMarginPercentInput,
    setMarginMode,

    live,
    display,

    toSubmitPayload,
    saveLocalDraft,
    clearLocalDraft,
    readOnly,
    hydrated,
    lastSaved,
    setLastSaved,
  };
}

/** Age-bucket filter, then a case-insensitive substring search. */
function applyFilter<
  T extends {
    serial_number: string;
    model_name: string | null;
    model_type: string | null;
    age_badge: "fresh" | "ageing" | "old";
    recommended: boolean;
  },
>(rows: T[], filter: AgeFilter, search: string): T[] {
  const byBucket = (() => {
    switch (filter) {
      case "recommended":
        return rows.filter((r) => r.recommended);
      case "ageing":
        return rows.filter((r) => r.age_badge === "ageing");
      case "old":
        return rows.filter((r) => r.age_badge === "old");
      default:
        return rows;
    }
  })();
  const q = search.trim().toLowerCase();
  if (!q) return byBucket;
  return byBucket.filter((r) =>
    [r.serial_number, r.model_name, r.model_type]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
}
