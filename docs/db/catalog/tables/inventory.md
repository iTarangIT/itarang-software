# `inventory`

Drizzle export: `inventory`
Sandbox row count: `0`
Primary surface: `/api/orders`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `varchar` | no | — |
| `product_id` | `uuid` | yes | — |
| `oem_id` | `varchar` | no | — |
| `oem_name` | `text` | no | — |
| `asset_category` | `text` | no | — |
| `asset_type` | `text` | no | — |
| `model_type` | `text` | no | — |
| `is_serialized` | `bool` | no | yes |
| `serial_number` | `varchar` | yes | — |
| `batch_number` | `varchar` | yes | — |
| `iot_imei_no` | `varchar` | yes | — |
| `quantity` | `int4` | yes | — |
| `manufacturing_date` | `timestamptz` | no | — |
| `expiry_date` | `timestamptz` | no | — |
| `inventory_amount` | `numeric` | no | — |
| `gst_percent` | `numeric` | no | — |
| `gst_amount` | `numeric` | no | — |
| `final_amount` | `numeric` | no | — |
| `oem_invoice_number` | `text` | no | — |
| `oem_invoice_date` | `timestamptz` | no | — |
| `oem_invoice_url` | `text` | yes | — |
| `product_manual_url` | `text` | yes | — |
| `warranty_document_url` | `text` | yes | — |
| `status` | `varchar` | no | yes |
| `warehouse_location` | `text` | yes | — |
| `dealer_id` | `varchar` | yes | — |
| `linked_lead_id` | `varchar` | yes | — |
| `dispatch_date` | `timestamptz` | yes | — |
| `soc_percent` | `numeric` | yes | — |
| `soc_last_sync_at` | `timestamptz` | yes | — |
| `created_by` | `uuid` | no | — |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `inventory_created_by_users_id_fk` | `created_by` | `users`(`id`) | no action |
| `inventory_oem_id_oems_id_fk` | `oem_id` | `oems`(`id`) | no action |
| `inventory_product_id_products_id_fk` | `product_id` | `products`(`id`) | no action |

## Referenced by

### API routes (18)

- `src/app/api/admin/lead/[id]/product-selection/route.ts`
- `src/app/api/admin/lead/[id]/reject-loan/route.ts`
- `src/app/api/dashboard/[role]/route.ts`
- `src/app/api/dealer/stats/route.ts`
- `src/app/api/inventory/bulk-upload/route.ts`
- `src/app/api/inventory/dealer/[dealerId]/batteries/route.ts`
- `src/app/api/inventory/dealer/[dealerId]/chargers/route.ts`
- `src/app/api/inventory/dealer/[dealerId]/paraphernalia/route.ts`
- `src/app/api/inventory/route.ts`
- `src/app/api/lead/[id]/confirm-cash-sale/route.ts`
- `src/app/api/lead/[id]/step-5/confirm-dispatch/route.ts`
- `src/app/api/lead/[id]/submit-product-selection/route.ts`
- `src/app/api/orders/[id]/grn/route.ts`
- `src/app/api/orders/route.ts`
- `src/app/api/pdi/inventory/route.ts`
- `src/app/api/pdi/submit/route.ts`
- `src/app/api/provisions/inventory/route.ts`
- `src/app/api/search/global/route.ts`

### Pages (App Router) (12)

- `src/app/(auth)/login/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/[id]/product-selection/page.tsx`
- `src/app/(dashboard)/dealer-portal/leads/new/page.tsx`
- `src/app/(dashboard)/disputes/%5Bid%5D/page.tsx`
- `src/app/(dashboard)/inventory/bulk-upload/page.tsx`
- `src/app/(dashboard)/inventory/page.tsx`
- `src/app/(dashboard)/orders/[id]/page.tsx`
- `src/app/(dashboard)/product-catalog/page.tsx`
- `src/app/(dashboard)/provisions/[id]/create-order/page.tsx`
- `src/app/(dashboard)/service-engineer/page.tsx`
- `src/app/(dashboard)/service-engineer/pdi-queue/page.tsx`
- `src/app/(dashboard)/service-engineer/pdi/[id]/page.tsx`

### Library / services (6)

- `src/lib/agreement/dealer-agreement-template.ts`
- `src/lib/db/schema.ts`
- `src/lib/db/seed-all.ts`
- `src/lib/db/seed-full-dashboard.ts`
- `src/lib/roles.ts`
- `src/lib/sales/sale-finalization.ts`
