# `risk_hypotheses`

Drizzle export: `riskHypotheses`
Sandbox row count: `20`
Primary surface: `/nbfc/risk`

## Columns

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | `uuid` | no | yes |
| `slug` | `text` | no | — |
| `title` | `text` | no | — |
| `description` | `text` | no | — |
| `test_method` | `varchar` | no | — |
| `test_definition` | `jsonb` | no | — |
| `source` | `varchar` | no | yes |
| `created_at` | `timestamptz` | no | yes |
| `retired_at` | `timestamptz` | yes | — |

**Primary key:** `id`

## Referenced by

### API routes (0)

_No references._

### Pages (App Router) (3)

- `src/app/(dashboard)/nbfc/_components/RiskDistributionDonut.tsx`
- `src/app/(dashboard)/nbfc/audit/page.tsx`
- `src/app/(dashboard)/nbfc/risk/page.tsx`

### Library / services (2)

- `src/lib/ai/langgraph/risk-hypothesis-graph.ts`
- `src/lib/db/schema.ts`
