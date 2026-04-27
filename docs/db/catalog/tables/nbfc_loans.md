# `nbfc_loans`

Drizzle export: `nbfcLoans`
Sandbox row count: `10`
Primary surface: `/api/nbfc/loans/import`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `loan_application_id` | `varchar` | no | — |
| `tenant_id` | `uuid` | no | — |
| `vehicleno` | `varchar` | yes | — |
| `emi_amount` | `numeric` | yes | — |
| `emi_due_date_dom` | `int4` | yes | — |
| `current_dpd` | `int4` | no | yes |
| `outstanding_amount` | `numeric` | yes | — |
| `is_active` | `bool` | no | yes |
| `created_at` | `timestamptz` | no | yes |
| `updated_at` | `timestamptz` | no | yes |

**Primary key:** `loan_application_id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `nbfc_loans_loan_application_id_loan_applications_id_fk` | `loan_application_id` | `loan_applications`(`id`) | cascade |
| `nbfc_loans_tenant_id_nbfc_tenants_id_fk` | `tenant_id` | `nbfc_tenants`(`id`) | restrict |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `nbfc_loans_dpd_idx` | `current_dpd` | no |
| `nbfc_loans_tenant_idx` | `tenant_id` | no |
| `nbfc_loans_vno_idx` | `vehicleno` | no |

## Referenced by

### API routes (2)

- `src/app/api/nbfc/loans/import/route.ts`
- `src/app/api/nbfc/loans/refresh-dpd/route.ts`

### Pages (App Router) (0)

_No references._

### Library / services (5)

- `src/lib/ai/langgraph/risk-hypothesis-graph.ts`
- `src/lib/ai/langgraph/risk-tools.ts`
- `src/lib/db/iot-queries.ts`
- `src/lib/db/schema.ts`
- `src/lib/nbfc/tenant.ts`
