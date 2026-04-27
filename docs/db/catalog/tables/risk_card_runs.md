# `risk_card_runs`

Drizzle export: `riskCardRuns`
Sandbox row count: `26`
Primary surface: `/api/nbfc/risk/run`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `uuid` | no | yes |
| `tenant_id` | `uuid` | no | — |
| `hypothesis_id` | `uuid` | no | — |
| `run_at` | `timestamptz` | no | yes |
| `severity` | `varchar` | no | — |
| `finding_summary` | `text` | no | — |
| `affected_count` | `int4` | no | yes |
| `total_count` | `int4` | no | yes |
| `evidence_json` | `jsonb` | yes | — |
| `llm_critique` | `text` | yes | — |
| `llm_model` | `varchar` | yes | — |
| `llm_prompt_tokens` | `int4` | yes | — |
| `llm_completion_tokens` | `int4` | yes | — |

**Primary key:** `id`

## Foreign keys

| Constraint | Columns | References | On delete |
| --- | --- | --- | --- |
| `risk_card_runs_hypothesis_id_risk_hypotheses_id_fk` | `hypothesis_id` | `risk_hypotheses`(`id`) | cascade |
| `risk_card_runs_tenant_id_nbfc_tenants_id_fk` | `tenant_id` | `nbfc_tenants`(`id`) | cascade |

## Indexes

| Name | Columns | Unique |
| --- | --- | --- |
| `risk_card_runs_severity_idx` | `severity` | no |
| `risk_card_runs_tenant_hyp_idx` | `tenant_id`, `hypothesis_id` | no |
| `risk_card_runs_tenant_run_idx` | `tenant_id`, `run_at` | no |

## Referenced by

### API routes (1)

- `src/app/api/nbfc/risk/run/route.ts`

### Pages (App Router) (4)

- `src/app/(dashboard)/nbfc/_components/RiskDistributionDonut.tsx`
- `src/app/(dashboard)/nbfc/audit/page.tsx`
- `src/app/(dashboard)/nbfc/risk/_components/RiskCardDrawer.tsx`
- `src/app/(dashboard)/nbfc/risk/page.tsx`

### Library / services (3)

- `src/lib/ai/langgraph/risk-hypothesis-graph.ts`
- `src/lib/db/schema.ts`
- `src/lib/risk/hand-coded-cards.ts`
