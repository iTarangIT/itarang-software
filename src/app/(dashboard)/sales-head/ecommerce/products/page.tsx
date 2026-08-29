import { ECOMMERCE_ADMIN_ROLES, requireRole } from "@/lib/auth-utils";
import { LiveCatalogBanner } from "./_components/LiveCatalogBanner";
import { EcommerceProductListView } from "./_components/EcommerceProductListView";

export const dynamic = "force-dynamic";

/**
 * Hostinger Ecommerce — product list. READ-ONLY.
 *
 * Create/edit/delete and inventory editing are separately gated phases and are
 * intentionally absent, so the UI never offers an action the backend cannot
 * honour.
 */
export default async function EcommerceProductsPage() {
    await requireRole([...ECOMMERCE_ADMIN_ROLES]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                    Ecommerce Products
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    The Hostinger Ecommerce catalog, viewed from the CRM.
                </p>
            </header>
            <LiveCatalogBanner />
            <EcommerceProductListView />
        </div>
    );
}
