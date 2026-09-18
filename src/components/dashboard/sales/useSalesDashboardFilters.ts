"use client";

// B7 — the sales dashboard's filter state lives in the URL, not in React
// state, so a filtered view survives a refresh and the address bar can be
// pasted into WhatsApp. Param names match the API's query contract exactly,
// so the same string is both the page URL and the fetch URL.

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
    SALES_DASHBOARD_GRANULARITIES,
    type SalesDashboardGranularity,
} from "@/lib/admin/salesDashboardTypes";

export const SALES_FILTER_KEYS = [
    "from",
    "to",
    "state",
    "city",
    "spoc_id",
    "business_type",
    "granularity",
] as const;
export type SalesFilterKey = (typeof SALES_FILTER_KEYS)[number];

export type SalesFilters = Record<SalesFilterKey, string>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function readFilters(sp: URLSearchParams): SalesFilters {
    const g = sp.get("granularity") ?? "";
    return {
        from: ISO_DATE.test(sp.get("from") ?? "") ? sp.get("from")! : "",
        to: ISO_DATE.test(sp.get("to") ?? "") ? sp.get("to")! : "",
        state: sp.get("state")?.trim() ?? "",
        city: sp.get("city")?.trim() ?? "",
        spoc_id: sp.get("spoc_id")?.trim() ?? "",
        business_type: sp.get("business_type")?.trim() ?? "",
        granularity: (SALES_DASHBOARD_GRANULARITIES as readonly string[]).includes(g) ? g : "day",
    };
}

/**
 * @param includeSpoc  false on the ASM / ISR screens — the rep is the session,
 *                     so a spoc_id in a pasted admin link is dropped rather than
 *                     shown as a filter the API will ignore anyway.
 */
export function useSalesDashboardFilters(includeSpoc: boolean) {
    const router = useRouter();
    const pathname = usePathname();
    const sp = useSearchParams();

    const filters = useMemo(() => {
        const f = readFilters(new URLSearchParams(sp.toString()));
        if (!includeSpoc) f.spoc_id = "";
        return f;
    }, [sp, includeSpoc]);

    /** The query string for BOTH the page and the API. Defaults are omitted. */
    const qs = useMemo(() => {
        const p = new URLSearchParams();
        for (const k of SALES_FILTER_KEYS) {
            const v = filters[k];
            if (!v) continue;
            if (k === "granularity" && v === "day") continue;
            p.set(k, v);
        }
        return p.toString();
    }, [filters]);

    const write = useCallback(
        (next: SalesFilters) => {
            const p = new URLSearchParams();
            for (const k of SALES_FILTER_KEYS) {
                const v = next[k];
                if (!v) continue;
                if (k === "granularity" && v === "day") continue;
                p.set(k, v);
            }
            const s = p.toString();
            router.replace(`${pathname}${s ? `?${s}` : ""}`, { scroll: false });
        },
        [router, pathname],
    );

    const set = useCallback(
        (key: SalesFilterKey, value: string) => {
            const next = { ...filters, [key]: value };
            // A state change invalidates a city that belonged to the old state.
            if (key === "state") next.city = "";
            write(next);
        },
        [filters, write],
    );

    const reset = useCallback(() => {
        write({ from: "", to: "", state: "", city: "", spoc_id: "", business_type: "", granularity: "day" });
    }, [write]);

    const dirty = qs.length > 0;
    const granularity = filters.granularity as SalesDashboardGranularity;

    return { filters, granularity, qs, set, reset, dirty };
}
