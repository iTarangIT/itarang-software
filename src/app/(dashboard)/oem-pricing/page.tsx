"use client";

/**
 * E-230 — /oem-pricing, "OEM Inventory Pricing".
 *
 * This is the screen the requirement put on the OEM tab, in place of OEM
 * Onboarding: "on the OEM screen, build an OEM Inventory Pricing module — pick
 * the category, pick the model from inventory, set a price, and that price has
 * a validity period."
 *
 * It is also the ONE place OEM prices are maintained. E-226 had shipped the same
 * register at /ceo/oem-prices; that route now redirects here rather than
 * standing as a second door to the same table, which is the specific complaint
 * the same call raised about the leads screens ("multiple gates to reach one
 * single place").
 *
 * Client component + React Query, matching every other dashboard page. Route
 * access is gated in src/middleware.ts and the API re-asserts the role (ceo,
 * admin) — the requirement names Admin alongside the CEO throughout, so this is
 * deliberately not CEO-only.
 */

import React from "react";
import { OemInventoryPricing } from "@/components/dashboard/oem/OemInventoryPricing";
import { OemPriceHistory } from "@/components/dashboard/oem/OemPriceHistory";

export default function OemPricingPage() {
    return (
        <div className="space-y-6 pb-12">
            <div>
                <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
                    OEM Inventory Pricing
                </h1>
                <p className="text-sm text-gray-500 mt-1">
                    What we would pay the OEM to reorder each model today — not what the
                    stock on hand cost us. Every dealer quotation is checked against the
                    price in force on the day it is raised: at or above it the quote
                    releases automatically, below it the quote comes to the CEO. A price
                    carries a validity window, and you change it by adding the next line
                    rather than editing this one, so past quotes stay auditable against
                    the number that actually judged them.
                </p>
            </div>

            <OemInventoryPricing />

            {/*
              * E-242 — the full ledger, under the register that writes it.
              * Same screen on purpose: the register and its history are one
              * subject, and a separate page would be the second door the same
              * call complained about.
              */}
            <OemPriceHistory />
        </div>
    );
}
