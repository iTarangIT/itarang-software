"use client";

/**
 * E-226 — /ceo/oem-prices
 *
 * The reference price book behind quotation auto-approval. A quote whose every
 * line is at or above the price set here releases to the dealer without
 * reaching the approval queue; anything below it, or against a product with no
 * price here, waits for the CEO.
 *
 * Client component + React Query, matching every other page under /ceo. There
 * is no ceo/layout.tsx — src/middleware.ts gates the route and the API
 * re-asserts the role.
 */

import React from "react";
import { OemPriceTable } from "@/components/dashboard/ceo/OemPriceTable";

export default function OemPricesPage() {
    return (
        <div className="space-y-6 pb-12">
            <div>
                <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
                    OEM Reference Prices
                </h1>
                <p className="text-sm text-gray-500 mt-1">
                    The benchmark every dealer quotation is checked against. A quote at or
                    above these prices is approved automatically; one below any of them comes
                    to you. Revising a price never overwrites the old one — past quotes stay
                    auditable against the price that was live when they were raised.
                </p>
            </div>

            <OemPriceTable />
        </div>
    );
}
