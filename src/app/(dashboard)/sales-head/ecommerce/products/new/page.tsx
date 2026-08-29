import { ECOMMERCE_ADMIN_ROLES, requireRole } from "@/lib/auth-utils";
import { LiveCatalogBanner } from "../_components/LiveCatalogBanner";
import { CreateProductForm } from "./_components/CreateProductForm";

export const dynamic = "force-dynamic";

export default async function NewEcommerceProductPage() {
    await requireRole([...ECOMMERCE_ADMIN_ROLES]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[900px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">New product</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Creates the product directly in Hostinger Ecommerce.
                </p>
            </header>
            <LiveCatalogBanner />
            <CreateProductForm />
        </div>
    );
}
