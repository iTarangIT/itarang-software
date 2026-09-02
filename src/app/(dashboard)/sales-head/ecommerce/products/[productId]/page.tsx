import { ECOMMERCE_ADMIN_ROLES, requireRole } from "@/lib/auth-utils";
import { LiveCatalogBanner } from "../_components/LiveCatalogBanner";
import { EcommerceProductDetailView } from "./_components/EcommerceProductDetailView";

export const dynamic = "force-dynamic";

/**
 * Hostinger Ecommerce — product detail. READ-ONLY.
 *
 * Variants (and their stock) arrive embedded in the product payload; there is
 * no separate variants endpoint, so this renders from a single fetch.
 */
export default async function EcommerceProductDetailPage({
    params,
}: {
    params: Promise<{ productId: string }>;
}) {
    await requireRole([...ECOMMERCE_ADMIN_ROLES]);
    const { productId } = await params;

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <LiveCatalogBanner />
            <EcommerceProductDetailView productId={productId} />
        </div>
    );
}
