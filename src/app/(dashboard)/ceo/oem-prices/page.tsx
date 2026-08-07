/**
 * E-226 → E-230 — this route moved to /oem-pricing.
 *
 * E-226 put the reference price book under /ceo. E-230 moved it onto the OEM
 * tab as "OEM Inventory Pricing", where the requirement asked for it, and where
 * Admin can reach it too — the price book is named as an Admin responsibility
 * as often as a CEO one.
 *
 * Kept as a redirect rather than deleted: this path is in the CEO's history and
 * in E-226's own documentation, and a 404 there would read as the feature
 * having been removed. Server component with no client bundle — the redirect
 * happens before anything renders.
 */

import { redirect } from "next/navigation";

export default function OemPricesPage() {
    redirect("/oem-pricing");
}
