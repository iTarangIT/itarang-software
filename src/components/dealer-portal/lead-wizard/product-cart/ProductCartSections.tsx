"use client";

import { AlertCircle, Battery as BatteryIcon, Package, Plug } from "lucide-react";

import { SectionCard } from "@/components/dealer-portal/lead-wizard/shared";
import { BatteryCard, ChargerCard, SelectedBatterySummary } from "./cards";
import {
  CardPagination,
  CardSearchBar,
  EmptyState,
  FilterChip,
  SkeletonCardGrid,
} from "./list-chrome";
import { ParaphernaliaList } from "./paraphernalia";
import { ProductPhotoSection } from "./ProductPhotoSection";
import { PricingSummary } from "./PricingSummary";
import type { ProductCart } from "./useProductCart";

/**
 * The Battery / Charger / Paraphernalia cards.
 *
 * Returns a bare fragment with no wrapper and no grid classes — Step 4 lays
 * these out in a `space-y-6` left column and Step 5 in a `space-y-5` one, so
 * spacing belongs to the caller.
 */
export function ProductCartSections({
  cart,
  show,
}: {
  cart: ProductCart;
  show?: {
    battery?: boolean;
    charger?: boolean;
    paraphernalia?: boolean;
    photos?: boolean;
  };
}) {
  const showBattery = show?.battery ?? true;
  const showCharger = show?.charger ?? true;
  const showPara = show?.paraphernalia ?? true;
  const showPhotos = show?.photos ?? true;

  const { batteryList: bl, chargerList: cl, readOnly } = cart;

  return (
    <>
      {showBattery && (
        <>
          {/* Section B — Battery */}
          <SectionCard
            title="Battery"
            action={
              <div className="flex items-center gap-2 flex-wrap">
                <FilterChip
                  label={`All ${bl.scoped.length}`}
                  active={bl.filter === "all"}
                  onClick={() => bl.setFilter("all")}
                />
                {bl.recommendedCount > 0 && (
                  <FilterChip
                    label={`Recommended ${bl.recommendedCount}`}
                    active={bl.filter === "recommended"}
                    tone="emerald"
                    onClick={() => bl.setFilter("recommended")}
                  />
                )}
                {bl.ageingCount > 0 && (
                  <FilterChip
                    label={`Ageing ${bl.ageingCount}`}
                    active={bl.filter === "ageing"}
                    tone="amber"
                    onClick={() => bl.setFilter("ageing")}
                  />
                )}
                {bl.oldCount > 0 && (
                  <FilterChip
                    label={`Old ${bl.oldCount}`}
                    active={bl.filter === "old"}
                    tone="red"
                    onClick={() => bl.setFilter("old")}
                  />
                )}
              </div>
            }
          >
            {bl.loading ? (
              <SkeletonCardGrid />
            ) : cart.batteries.length === 0 ? (
              <EmptyState
                icon={<BatteryIcon className="w-10 h-10 text-gray-300" />}
                title="No battery stock in this category"
                hint="Your dealership has no available batteries in this category yet. Ask your admin to add inventory (Inventory → Add Item / Bulk Upload) for this category, then refresh."
              />
            ) : bl.scoped.length === 0 ? (
              <EmptyState
                icon={<BatteryIcon className="w-10 h-10 text-gray-300" />}
                title="No batteries match the selected product type"
                hint="Your dealership has battery stock in this category, but none matches the Product Type chosen in Step 1. Change the Product Type above, or ask your admin to stock a matching battery."
              />
            ) : (
              <>
                <CardSearchBar
                  value={bl.search}
                  onChange={bl.setSearch}
                  placeholder="Search by serial or model"
                />
                {bl.filtered.length === 0 ? (
                  <EmptyState
                    icon={<BatteryIcon className="w-10 h-10 text-gray-300" />}
                    title="No batteries match this filter"
                    hint="Try clearing the search or selecting a different age filter."
                  />
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {bl.paginated.map((b) => (
                        <BatteryCard
                          key={b.id}
                          battery={b}
                          selected={cart.selectedBattery?.id === b.id}
                          onSelect={() => cart.setSelectedBattery(b)}
                          disabled={readOnly}
                        />
                      ))}
                    </div>
                    <CardPagination
                      page={bl.page}
                      pageCount={bl.pageCount}
                      total={bl.filtered.length}
                      pageSize={bl.pageSize}
                      onChange={bl.setPage}
                    />
                  </>
                )}
              </>
            )}
          </SectionCard>

          {/* Selected Battery summary — drives the downstream cards */}
          {cart.selectedBattery && (
            <SelectedBatterySummary
              battery={cart.selectedBattery}
              price={cart.live.batteryTriple.net}
            />
          )}

          {/* Addendum V0.1 §5.1 — serial close-up + unit photo. */}
          {showPhotos && cart.selectedBattery && !readOnly && (
            <ProductPhotoSection
              title="Battery Photos"
              subtitle="Take a clear photo of the battery serial sticker and the battery itself, at your premises."
              kind="battery"
              urls={cart.batteryPhotoUrls}
              onAdd={(label, file) => cart.uploadPhoto("battery", label, file)}
              onRemove={(idx) => cart.removePhoto("battery", idx)}
              uploadingTag={cart.photoUploading}
            />
          )}
        </>
      )}

      {showCharger && (
        <>
          {/* Section C — Charger */}
          <SectionCard
            title="Charger"
            action={
              cart.selectedBattery && cl.scoped.length > 0 ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <FilterChip
                    label={`All ${cl.scoped.length}`}
                    active={cl.filter === "all"}
                    onClick={() => cl.setFilter("all")}
                  />
                  {cl.recommendedCount > 0 && (
                    <FilterChip
                      label={`Recommended ${cl.recommendedCount}`}
                      active={cl.filter === "recommended"}
                      tone="emerald"
                      onClick={() => cl.setFilter("recommended")}
                    />
                  )}
                  {cl.ageingCount > 0 && (
                    <FilterChip
                      label={`Ageing ${cl.ageingCount}`}
                      active={cl.filter === "ageing"}
                      tone="amber"
                      onClick={() => cl.setFilter("ageing")}
                    />
                  )}
                  {cl.oldCount > 0 && (
                    <FilterChip
                      label={`Old ${cl.oldCount}`}
                      active={cl.filter === "old"}
                      tone="red"
                      onClick={() => cl.setFilter("old")}
                    />
                  )}
                </div>
              ) : null
            }
          >
            {!cart.selectedBattery ? (
              <EmptyState
                icon={<Plug className="w-10 h-10 text-gray-300" />}
                title="Select a battery first"
                hint="Available chargers from your inventory will appear once a battery is selected."
              />
            ) : cl.loading ? (
              <SkeletonCardGrid />
            ) : cart.chargers.length === 0 ? (
              <EmptyState
                icon={<Plug className="w-10 h-10 text-gray-300" />}
                title="No chargers available in your inventory"
                hint="Contact your inventory manager to add chargers for this category."
              />
            ) : cl.scoped.length === 0 ? (
              <EmptyState
                icon={<Plug className="w-10 h-10 text-gray-300" />}
                title="No chargers match the selected product type"
                hint="Your dealership has charger stock in this category, but none matches the Product Type chosen in Step 1. Change the Product Type above, or ask your admin to stock a matching charger."
              />
            ) : (
              <>
                <p className="text-[11px] text-gray-400 mb-3 px-1">
                  Pair with{" "}
                  <strong className="text-gray-700">
                    {cart.selectedBattery.model_name ||
                      cart.selectedBattery.model_type ||
                      "the selected battery"}
                  </strong>
                  . Oldest stock surfaces first (FIFO).
                </p>
                <CardSearchBar
                  value={cl.search}
                  onChange={cl.setSearch}
                  placeholder="Search by serial or model"
                />
                {cl.filtered.length === 0 ? (
                  <EmptyState
                    icon={<Plug className="w-10 h-10 text-gray-300" />}
                    title="No chargers match this filter"
                    hint="Try clearing the search or selecting a different age filter."
                  />
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {cl.paginated.map((c) => (
                        <ChargerCard
                          key={c.id}
                          charger={c}
                          selected={cart.selectedCharger?.id === c.id}
                          onSelect={() => cart.setSelectedCharger(c)}
                          disabled={readOnly}
                        />
                      ))}
                    </div>
                    <CardPagination
                      page={cl.page}
                      pageCount={cl.pageCount}
                      total={cl.filtered.length}
                      pageSize={cl.pageSize}
                      onChange={cl.setPage}
                    />
                  </>
                )}
              </>
            )}
          </SectionCard>

          {showPhotos && cart.selectedCharger && !readOnly && (
            <ProductPhotoSection
              title="Charger Photos"
              subtitle="Take a clear photo of the charger serial sticker and the charger itself, at your premises."
              kind="charger"
              urls={cart.chargerPhotoUrls}
              onAdd={(label, file) => cart.uploadPhoto("charger", label, file)}
              onRemove={(idx) => cart.removePhoto("charger", idx)}
              uploadingTag={cart.photoUploading}
            />
          )}
        </>
      )}

      {cart.photoError && (
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-xs font-medium text-red-700 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{cart.photoError}</span>
        </div>
      )}

      {showPara && (
        /* Section D — Paraphernalia */
        <SectionCard title="Paraphernalia">
          {cart.scopedParaphernalia.length === 0 ? (
            <EmptyState
              icon={<Package className="w-10 h-10 text-gray-300" />}
              title="No paraphernalia available"
              hint={
                cart.paraphernalia.length > 0
                  ? "No paraphernalia matches the selected product types."
                  : "No add-on items in this category for your inventory."
              }
            />
          ) : (
            <ParaphernaliaList
              items={cart.scopedParaphernalia}
              paraQty={cart.paraQty}
              onChangeQty={cart.setParaQty}
              disabled={readOnly}
            />
          )}
        </SectionCard>
      )}
    </>
  );
}

/** The pricing rail, wired to the cart. Each page places it in its own column. */
export function CartPricingSummary({
  cart,
  inventoryNote,
}: {
  cart: ProductCart;
  inventoryNote: string;
}) {
  const d = cart.display;
  return (
    <PricingSummary
      batteryPrice={d.batteryPrice}
      chargerPrice={d.chargerPrice}
      paraCost={d.paraCost}
      grossSubtotal={d.grossSubtotal}
      gstSubtotal={d.gstSubtotal}
      netSubtotal={d.netSubtotal}
      dealerMargin={d.dealerMargin}
      marginMode={cart.marginMode}
      marginInput={cart.marginInput}
      marginPercentInput={cart.marginPercentInput}
      onMarginChange={cart.setMarginInput}
      onMarginPercentChange={cart.setMarginPercentInput}
      onMarginModeChange={cart.setMarginMode}
      finalPrice={d.finalPrice}
      inventoryNote={inventoryNote}
      disabled={cart.readOnly}
    />
  );
}
