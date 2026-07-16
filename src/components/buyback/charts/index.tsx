"use client";

/**
 * Lazy entry point for the buyback chart kit. recharts is ~100 KB of client-only
 * JS; loading it via `next/dynamic` with `ssr:false` keeps the dashboard route
 * SSR-safe and off the shared bundle (house pattern — src/components/shared/charts.tsx).
 * Page code imports ONLY from here, never the chart files directly.
 */

import dynamic from "next/dynamic";

export type { MoneyFlowDatum } from "./MoneyFlowChart";
export type { MixDatum } from "./MixDonut";

const chartSkeleton = (
  <div className="h-[260px] animate-pulse rounded bg-slate-100" />
);

export const MoneyFlowChart = dynamic(() => import("./MoneyFlowChart"), {
  ssr: false,
  loading: () => chartSkeleton,
});

export const MixDonut = dynamic(() => import("./MixDonut"), {
  ssr: false,
  loading: () => chartSkeleton,
});
