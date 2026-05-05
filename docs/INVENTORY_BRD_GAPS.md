# Inventory Module — BRD §7.1 Gap Tracker

Living checklist against BRD V2 §5.0 / §5.1 / §5.2 ("Dealer Inventory Management & Product Master"). Source of truth for what's shipped and what's queued.

**Legend**: ✓ shipped · ⚠ partial · ✗ missing

## Database schema

### `inventory` table — column-level

| BRD column | Status | Notes |
|---|---|---|
| `inventory_id` (VARCHAR50, format `INV-YYYY-TYPE-SEQ`) | ⚠ | Currently uses `id` (varchar 255). Format-of-id work would require a backfill. |
| `serial_number` | ✓ | |
| `imei_id` | ✓ | Stored as `iot_imei_no`. |
| `iot_enabled` (BOOLEAN) | ✗ | Currently derived from `iot_imei_no IS NOT NULL`. Add explicit column for telemetry queries. |
| `material_code` (OEM ref) | ✗ | Distinct from serial; needed for OEM warranty claim routing. |
| `inventory_type` (ENUM) | ✓ | Stored as `asset_category`. |
| `dealer_id` | ✓ | |
| `category` | ✓ | `asset_category`. |
| `sub_category` | ⚠ | Reuses `asset_type`; BRD wants a dedicated column for E-Rickshaw / E-Cart / E-Auto. |
| `model_number` | ✓ | `model_type`. |
| `voltage_v` / `capacity_ah` | ✓ | Joined via `products`. |
| `compatible_models` (chargers) | ✗ | JSON array of compatible battery model_ids — currently absent. |
| `star_rating` (1–5) | ✗ | BRD field 10. Surface as null in ageing report today. |
| `invoice_number` | ✓ | `oem_invoice_number`. |
| `invoice_date` (Sold Date) | ✓ | `oem_invoice_date`. |
| `invoice_value` | ✓ | `inventory_amount`. |
| `supplier_name` | ✓ | `oem_name`. |
| `oem_warranty_date` | ⚠ | Currently `manufacturing_date` is reused as a proxy. BRD wants distinct column. |
| `oem_warranty_months` | ✓ | `warranty_months`. |
| `oem_warranty_expiry` (computed) | ✗ | Computed in queries, not stored. Add for query-perf and alert cron. |
| `oem_warranty_clauses` (TEXT) | ✗ | Required for after-sales claim processing. |
| `batch_reference` | ✓ | `batch_number`. |
| `physical_condition` (ENUM new/refurbished/demo) | ✗ | Affects min-price floor. |
| `warehouse_location` | ✓ | |
| `status` | ✓ | Add `transferred_in` value (currently only `transferred_out`). |
| `linked_lead_id` | ✓ | |
| `upload_event_id` | ✓ | Links via `inventoryUploadReports`. |
| `created_by`, `created_at`, `updated_at` | ✓ | |

### Other tables

| BRD table | Status | Notes |
|---|---|---|
| `paraphernalia_stock` (separate quantity-tracked) | ✗ | Today paraphernalia rides on `inventory` rows. BRD wants a dedicated table with `available_qty / reserved_qty / sold_qty` columns. Refactor required. |
| `inventory_events` (per-row audit log) | ✗ | No event log today. BRD requires `uploaded / reserved / released / sold / written_off / transfer_initiated / transfer_received / iot_linked / edited`. |
| `inventory_upload_events` | ✓ | Implemented as `inventoryUploadReports`. |
| `inventory_transfers` | ✓ | Just shipped — apply `drizzle/migrations/0001_inventory_transfers.sql` if not yet. |
| `product_master_batteries` | ⚠ | Implemented as `products`. Doesn't yet carry `compatible_charger_models` JSON, `iot_compatible` flag. |
| `product_master_chargers` (separate) | ✗ | Today chargers live in same `products` table. |
| `product_master_paraphernalia` | ✗ | |
| `security_audit_log` | ✗ | BRD requires forbidden-access logging. Not built yet. |

## API endpoints

### Admin

| BRD endpoint | Status | File |
|---|---|---|
| `GET /api/admin/dealers?search=` | ✓ | `src/app/api/admin/dealers/route.ts` |
| `GET /api/admin/inventory/csv-template` | ✓ | |
| `POST /api/admin/inventory/bulk-upload` | ✓ | |
| `POST /api/admin/inventory/add-item` | ✓ | |
| `GET /api/admin/inventory/all` | ✓ | |
| `POST /api/admin/inventory/:serial/write-off` | ⚠ | Implemented at `/api/admin/inventory/[itemId]/write-off` (uses internal id rather than serial). |
| `POST /api/admin/inventory/transfer` | ✓ | Just shipped. |
| `GET /api/admin/inventory/ageing-report` | ✓ | Just shipped. JSON + CSV. |

### Dealer

| BRD endpoint | Status | File |
|---|---|---|
| `GET /api/inventory/dealer/:dealerId/batteries` | ✓ | `src/app/api/inventory/dealer/[dealerId]/batteries/route.ts` |
| `GET /api/inventory/dealer/:dealerId/chargers` | ✓ | `src/app/api/inventory/dealer/[dealerId]/chargers/route.ts` |
| `GET /api/inventory/dealer/:dealerId/paraphernalia` | ⚠ | Verify exists / shape; absent in current grep. |
| `POST /api/dealer/inventory/acknowledge-transfer` | ✓ | Just shipped. |

### System / shared

| BRD endpoint | Status | Notes |
|---|---|---|
| `GET /api/inventory/categories` | ✗ → ✓ | **This round.** |
| `GET /api/inventory/:serial/card` (Battery Detail Card) | ✗ → ✓ | **This round.** |
| `POST /api/lead/:leadId/reserve-inventory` | ⚠ | Logic lives inline inside `/api/lead/[id]/submit-product-selection/route.ts` — uses row-level reservation, but doesn't expose a standalone endpoint. Functionally equivalent. |
| `POST /api/inventory/:serial/sell` | ⚠ | Logic lives inline inside `confirm-dispatch` and `confirm-cash-sale`. Internal-only by design — matches BRD intent. |
| `POST /api/inventory/release` | ✗ | Reject-loan inlines this; no standalone endpoint. |
| `GET /api/iot/battery/:serial/soc` | ✗ | No IoT integration yet. SOC currently sourced from `inventory.soc_percent` snapshot. |

### Product master

| BRD endpoint | Status | Notes |
|---|---|---|
| `GET/POST /api/admin/product-master/batteries` | ✗ | Need full CRUD + admin UI. |
| `PUT /api/admin/product-master/batteries/:modelId` | ✗ | Plus `price_history` snapshot side-table. |
| Same for chargers, paraphernalia | ✗ | |

## UI views

### Admin

| BRD screen | Status | Notes |
|---|---|---|
| Inventory Dashboard with Network Summary + Ageing Alert + Quick Actions | ⚠ → ✓ | **Polished this round.** |
| Bulk Upload wizard (4-step) | ✓ | |
| Add Item form | ✓ | |
| Ageing Report page | ✓ | Just shipped. |
| Transfer page | ✓ | Just shipped. |
| Write-off form | ✓ | At `/admin/inventory/[itemId]/write-off`. |
| Battery Detail Card modal | ✗ → ✓ | **This round.** |
| Product Master CRUD pages | ✗ | Future round. |
| All-Serials cross-dealer view | ⚠ | `/admin/inventory` is the cross-dealer view; "All Serials" sub-page not separated. |

### Dealer

| BRD screen | Status | Notes |
|---|---|---|
| `/dealer-portal/inventory` page with Battery / Charger / Paraphernalia tabs | ⚠ | Page exists; verify tab structure + ageing alert banner. |
| Battery Detail Card modal | ⚠ | Reuse the admin one once shipped (read-only for dealer). |
| Incoming Transfers tab | ✗ | Acknowledge-transfer API exists; UI needed. |
| Filters & search | ⚠ | Verify current state. |

## Validation & business rules

| BRD rule | Status |
|---|---|
| BR-01 Serial immutable | ✓ |
| BR-02 Category / sub-category immutable | ✓ |
| BR-03 IMEI unique | ⚠ Application-level check. No DB unique index yet. |
| BR-04 Model_number FK to product master | ✓ |
| BR-05 Step 4 only shows status='available' & matching dealer | ✓ |
| BR-06 Row-level lock on reservation | ✓ Implemented inline. |
| BR-07 Sold cannot revert (except formal exception) | ✓ Default flow. No exception path yet. |
| BR-08 Margin / min-price enforced server-side | ✓ |
| BR-09 Price snapshot in product_selections at submit | ✓ Stored in selection columns. |
| BR-10 Paraphernalia deducted at sale, not Step 4 submit | ⚠ Today there's no separate paraphernalia stock to deduct. |
| BR-11 OEM clauses surfaced in detail card | ✗ Schema gap. |
| BR-12 `warranty.battery_serial` FK to inventory | ✓ Via `deployedAssets`. |

## Non-functional

| BRD requirement | Status |
|---|---|
| HTTPS / TLS 1.2 | ✓ Vercel default |
| Parameterised queries (no SQL injection) | ✓ Drizzle ORM |
| `inventory_events` log inside same tx as the change | ✗ |
| `security_audit_log` async write | ✗ |
| 500-row upload completes in <10s | ⚠ Untested; no streaming yet |
| 409-rate alerting on reserve | ✗ No metrics |

## BRD §5.0.2.4 — Battery upload field-level audit

20 fields per BRD. Status against current bulk-upload + CSV template:

| # | BRD field | DB column | Status |
|---|---|---|---|
| 1 | Battery ID | `serial_number` | ✓ |
| 2 | IMEI ID | `iot_imei_no` | ✓ (named differently — alias would help) |
| 3 | IoT Enabled | `iot_enabled` BOOLEAN | ✗ derived today |
| 4 | Material Code | `material_code` | ✗ |
| 5 | Product Category | `asset_category` | ✓ |
| 6 | Product Sub-Category | `sub_category` | ⚠ overloaded into `asset_type` |
| 7 | Model Number | `model_type` | ✓ |
| 8 | Voltage | `voltage_v` | ✓ via products |
| 9 | Capacity | `capacity_ah` | ✓ via products |
| 10 | Star Rating | `star_rating` | ✗ |
| 11 | Invoice Number | `oem_invoice_number` | ✓ |
| 12 | Sold Date | `oem_invoice_date` | ✓ (label rename `invoice_date` → `sold_date` in CSV would match BRD) |
| 13 | Invoice Value | `inventory_amount` | ✓ |
| 14 | Supplier / OEM | `oem_name` | ✓ |
| 15 | OEM Warranty Date | `oem_warranty_date` | ✗ |
| 16 | OEM Warranty Period | `warranty_months` | ✓ |
| 17 | OEM Warranty Clauses | `oem_warranty_clauses` TEXT | ✗ |
| 18 | Batch / PO Reference | `batch_number` | ✓ |
| 19 | Physical Condition | `physical_condition` ENUM | ✗ today free text |
| 20 | Warehouse / Location | `warehouse_location` | ✓ |

Six gaps (rows 3, 4, 6, 10, 15, 17, 19) need a schema migration and validate / bulk-upload route updates.

## BRD §5.0.2.5 — Charger upload (10 fields)

| BRD field | DB column | Status |
|---|---|---|
| Serial Number | `serial_number` | ✓ |
| Charger Model | `model_type` | ✓ |
| Compatible Battery Models | `compatible_models` JSON | ✗ |
| Output Voltage | `voltage_v` | ✓ via products |
| Output Current | `output_current_a` | ✗ |
| Invoice Number / Date / Value | existing | ✓ |
| Supplier | `oem_name` | ✓ |
| Physical Condition | as above | ✗ |

## BRD §5.0.2.6 — Paraphernalia upload (7 fields)

Currently rides on the inventory table. BRD calls for a separate `paraphernalia_stock` table with `available_qty / reserved_qty / sold_qty`. Refactor required.

## Roadmap (suggested order)

1. **R1 — Schema migration + CSV template extension**:
   - Add columns: `star_rating` int1-5, `material_code` varchar, `iot_enabled` bool, `physical_condition` enum, `oem_warranty_date` date, `oem_warranty_clauses` text, `sub_category` varchar, `output_current_a` decimal, `compatible_models` jsonb, `oem_warranty_expiry` (computed).
   - Update `csv-templates.ts` to expose the BRD column names + ordering.
   - Update `validate/route.ts` Zod schema to accept BRD aliases and enforce `star_rating ∈ [1,5]`, `physical_condition ∈ {new, refurbished, demo}`, `iot_enabled` requires `imei_id`.
   - Update `bulk-upload/route.ts` to persist the new columns.
2. **R2 — Audit log helper** wired into bulk-upload, add-item, reserve, release, sell, write-off, transfer, ack.
3. **R3 — Paraphernalia split**: dedicated `paraphernalia_stock` table + dealer view tab.
4. **R4 — Product master CRUD**: split into `product_master_batteries` / `_chargers` / `_paraphernalia`, add admin pages.
5. **R5 — Dealer inventory page polish**: tabs, ageing banner, incoming-transfer ack UI.
6. **R6 — IoT integration**: `/api/iot/battery/:serial/soc` + telemetry pull.
7. **R7 — Security log + observability**: `security_audit_log`, 409-rate metric.

Update this file as items ship.
