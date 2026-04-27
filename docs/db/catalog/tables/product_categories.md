# `product_categories`

Drizzle export: `productCategories`
Sandbox row count: `1`
Primary surface: `/api/product-catalog`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `uuid` | no | yes |
| `name` | `text` | no | — |
| `slug` | `text` | no | — |
| `is_active` | `bool` | no | yes |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Referenced by

### API routes (5)

- `src/app/api/bolna/tools/price-lookup/route.ts`
- `src/app/api/inventory/bulk-upload/route.ts`
- `src/app/api/inventory/categories/route.ts`
- `src/app/api/inventory/products/route.ts`
- `src/app/api/product-catalog/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (5)

- `src/lib/db/products.ts`
- `src/lib/db/schema.ts`
- `src/lib/db/seed-all.ts`
- `src/lib/db/seed-batteries.ts`
- `src/lib/db/seed-full-dashboard.ts`
