"use client";

// ID 171 — the "Invoices read up to <date>" caption for client screens. One
// shared query (cached 5 minutes) however many tiles show it.

import { useQuery } from "@tanstack/react-query";

import type { InvoiceFreshness } from "@/lib/sales/invoiceFreshnessRules";
import { InvoicesReadUpToLine } from "./InvoicesReadUpToLine";

export function useInvoiceFreshness() {
    return useQuery<InvoiceFreshness>({
        queryKey: ["invoice-freshness"],
        queryFn: async () => {
            const res = await fetch("/api/sales/invoice-freshness", { cache: "no-store" });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Could not read invoice freshness");
            return json.data;
        },
        staleTime: 5 * 60 * 1000,
        retry: false,
    });
}

export function InvoicesReadUpTo({ className }: { className?: string }) {
    const { data } = useInvoiceFreshness();
    return <InvoicesReadUpToLine f={data} className={className} />;
}
