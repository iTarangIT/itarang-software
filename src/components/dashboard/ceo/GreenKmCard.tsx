"use client";

/**
 * E-219 — "Green KM Covered": total distance the fleet drove inside the window.
 *
 * Fetches on its own rather than riding the /overview payload, because it is
 * the only CEO figure sourced from the IoT Postgres — a database reached over
 * an SSH tunnel that is routinely down. Its own query means its own skeleton
 * and its own failure, instead of an eight-second stall in front of every card.
 *
 * The card reports the pipeline's freshness alongside the number. `distance_rollup`
 * is written by an aggregator in the `iot_stack` repo whose sibling jobs are
 * known-dead (`trips` has never held a row), so "the total stopped moving" is a
 * real state — and one that looks exactly like a correct total unless it says so.
 */

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { KPICard } from "@/components/shared/kpi-card";
import { Leaf } from "lucide-react";
import { ceoWindowParams, type CeoWindow } from "./CeoFilterBar";

interface GreenKmData {
  reachable: boolean;
  reason?: string;
  totalKm: number;
  vehicles: number;
  newestBucket: string | null;
  stale: boolean;
  label: string;
}

/** "8,73,715 km" — Indian grouping, no decimals; a metre is noise at this scale. */
const formatKm = (km: number) =>
  `${Math.round(km).toLocaleString("en-IN")} km`;

const asDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : null;

export function GreenKmCard({ window: win }: { window: CeoWindow }) {
  const params = ceoWindowParams(win);
  const { data, isLoading, isError } = useQuery<GreenKmData>({
    queryKey: ["ceo-green-km", params.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/dashboard/ceo/green-km?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load Green KM");
      const json = await res.json();
      return json.data as GreenKmData;
    },
    refetchInterval: 300_000,
  });

  if (isLoading) {
    return (
      <KPICard title="Green KM Covered" value="…" subtitle="Reading telemetry" icon={Leaf} />
    );
  }

  // A failed request and an unreachable IoT database read the same to the
  // viewer: this number cannot be shown right now. Neither renders as zero —
  // zero km across a driving fleet is a claim, not an absence of data.
  if (isError || !data?.reachable) {
    return (
      <KPICard
        title="Green KM Covered"
        value="—"
        subtitle="Telemetry unreachable — start the IoT tunnel"
        icon={Leaf}
      />
    );
  }

  const freshness = asDate(data.newestBucket);

  return (
    <KPICard
      title="Green KM Covered"
      value={formatKm(data.totalKm)}
      subtitle={
        data.stale
          ? freshness
            ? `⚠ Rollups stale since ${freshness} — aggregator not running`
            : "⚠ No daily rollups recorded — aggregator not running"
          : `${data.vehicles.toLocaleString("en-IN")} vehicles · ${data.label}`
      }
      icon={Leaf}
    />
  );
}
