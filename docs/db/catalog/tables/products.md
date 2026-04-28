# `products`

Drizzle export: `products`
Sandbox row count: `11`
Primary surface: `/api/deals`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `uuid` | no | yes |
| `category_id` | `uuid` | no | — |
| `name` | `text` | no | — |
| `slug` | `text` | no | — |
| `voltage_v` | `int4` | yes | — |
| `capacity_ah` | `int4` | yes | — |
| `sku` | `text` | no | — |
| `hsn_code` | `varchar` | yes | — |
| `price` | `int4` | yes | — |
| `asset_type` | `varchar` | yes | — |
| `is_serialized` | `bool` | no | yes |
| `warranty_months` | `int4` | no | yes |
| `status` | `varchar` | no | yes |
| `sort_order` | `int4` | no | yes |
| `is_active` | `bool` | no | yes |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `products_category_id_product_categories_id_fk` | `category_id` | `product_categories`(`id`) | restrict |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `idx_products_category_sort` | `category_id`, `sort_order` | no |
| `idx_products_voltage_capacity` | `voltage_v`, `capacity_ah` | no |

## Referenced by

### API routes (12)

- `src/app/api/bolna/tools/price-lookup/route.ts`
- `src/app/api/deals/route.ts`
- `src/app/api/inventory/bulk-upload/route.ts`
- `src/app/api/inventory/dealer/[dealerId]/batteries/route.ts`
- `src/app/api/inventory/dealer/[dealerId]/chargers/route.ts`
- `src/app/api/inventory/dealer/[dealerId]/paraphernalia/route.ts`
- `src/app/api/inventory/products/route.ts`
- `src/app/api/inventory/route.ts`
- `src/app/api/pdi/inventory/route.ts`
- `src/app/api/product-catalog/[id]/disable/route.ts`
- `src/app/api/product-catalog/route.ts`
- `src/app/api/provisions/route.ts`

### Pages (App Router) (8)

- `src/app/(dashboard)/dealer-portal/inventory/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/new/page.tsx`
- `src/app/(dashboard)/deals/%5Bid%5D/page.tsx`
- `src/app/(dashboard)/deals/new/page.tsx`
- `src/app/(dashboard)/provisions/new/page.tsx`
- `src/app/(dashboard)/provisions/page.tsx`
- `src/app/(dashboard)/service-engineer/page.tsx`
- `src/app/(dashboard)/service-engineer/pdi/[id]/page.tsx`

### Library / services (9)

- `src/lib/agreement/dealer-agreement-template.ts`
- `src/lib/consent/consent-pdf-template.ts`
- `src/lib/db/products.ts`
- `src/lib/db/schema.ts`
- `src/lib/db/seed-all.ts`
- `src/lib/db/seed-batteries.ts`
- `src/lib/db/seed-full-dashboard.ts`
- `src/lib/firecrawl.ts`
- `src/lib/sales/sale-finalization.ts`
