import { ECOMMERCE_ADMIN_ROLES, requireRole } from "@/lib/auth-utils";
import { LiveCatalogBanner } from "../../_components/LiveCatalogBanner";
import { EditProductForm } from "./_components/EditProductForm";

export const dynamic = "force-dynamic";

export default async function EditEcommerceProductPage({
    params,
}: {
    params: Promise<{ productId: string }>;
}) {
    await requireRole([...ECOMMERCE_ADMIN_ROLES]);
    const { productId } = await params;

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[900px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">Edit product</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Changes are written straight to the Hostinger storefront.
                </p>
            </header>
            <LiveCatalogBanner />
            <EditProductForm productId={productId} />
        </div>
    );
}
