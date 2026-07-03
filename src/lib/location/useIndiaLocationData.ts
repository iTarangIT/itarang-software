"use client";

// country-state-city embeds its full world dataset (~hundreds of KB) in the
// client bundle when imported statically. This hook loads it on demand so
// pages with a state/city picker don't pay for it at first paint.
//
// Consumers must handle `loaded === false` (render dropdowns disabled with a
// loading placeholder) — data arrives one microtask-to-network-tick later.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ICity, IState } from "country-state-city";

type CscModule = typeof import("country-state-city");

const COUNTRY_ISO = "IN";

// Module-level cache: the import cost is paid once per session, and remounts
// (route changes, form resets) get the data synchronously on first render.
let cachedModule: CscModule | null = null;

export interface IndiaLocationData {
  loaded: boolean;
  /** All Indian states; empty until `loaded`. */
  states: IState[];
  /** Cities for a state ISO code; empty until `loaded`. */
  getCitiesOfState: (stateIso: string) => ICity[];
}

export function useIndiaLocationData(): IndiaLocationData {
  const [csc, setCsc] = useState<CscModule | null>(cachedModule);

  useEffect(() => {
    if (csc) return;
    let alive = true;
    import("country-state-city").then((mod) => {
      cachedModule = mod;
      if (alive) setCsc(mod);
    });
    return () => {
      alive = false;
    };
  }, [csc]);

  const states = useMemo(
    () => (csc ? csc.State.getStatesOfCountry(COUNTRY_ISO) : []),
    [csc],
  );

  const getCitiesOfState = useCallback(
    (stateIso: string) =>
      csc && stateIso ? csc.City.getCitiesOfState(COUNTRY_ISO, stateIso) : [],
    [csc],
  );

  return { loaded: csc !== null, states, getCitiesOfState };
}
