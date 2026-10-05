# Ecofy × iTarang — Developer Handoff v1.4

## 1. What you are building

A multi-tenant CRM/LMS workflow for Ecofy × iTarang covering lead intake and qualification, iTarang sales conversion, requirement assessment, offer/File creation, Ecofy financing states, EPC installation tracking, and post-disbursement asset lifecycle visibility.

The working case flow is:

**S0 Qualification → S1 Pickup Queue → S2 Follow-up → S3 Assessment → S4 Offer → S5 File → S6 Financing/Sanction → S7 Installation/Disbursement → S8 Asset**

Installation may progress as its own child workflow while the parent case remains in S6, as defined in the BRD.

## 2. Read these files in this order

1. **`01_PRODUCT_SPEC/Ecofy_CRM_LMS_BRD_v1.4.docx`** — functional product specification and workflow/gate behavior.
2. **`02_API_DATABASE/ecofy_openapi_v1.0.1.yaml`** — authoritative API request/response contract.
3. **`02_API_DATABASE/ecofy_schema_v1.4.sql`** — authoritative database/persistence/security contract.
4. **`02_API_DATABASE/ecofy_seed_v1.1.sql`** — authoritative initial defaults and seed values.
5. **`03_ACCEPTANCE/Ecofy_UAT_Scenarios_v1.1.xlsx`** — release acceptance / definition of done.

Use `04_INPUT_TEMPLATES` when implementing import/master-data workflows.

Everything under `05_REFERENCE_ONLY` is explanatory or visual reference only and **must not override the BRD, OpenAPI, schema, seed, or UAT pack**.

## 3. Authority rules

| Question | Authoritative source |
|---|---|
| What should the product do? | **BRD v1.4** |
| What API shape should be implemented? | **OpenAPI v1.0.1** |
| How is data persisted / isolated / constrained? | **Schema v1.4** |
| What are the initial configurable defaults? | **Seed v1.1** |
| How is release completion accepted? | **UAT v1.1** |
| What should the UI roughly look/feel like? | Prototype in `REFERENCE_ONLY` |
| Why was a business decision made? | Build Baseline in `REFERENCE_ONLY` |

**If authoritative files appear to conflict, stop and raise the conflict with iTarang. Do not choose or invent behavior.**

BRD tables and endpoint lists are explanatory summaries where a machine-readable technical contract exists. OpenAPI controls exact API structure; schema controls exact persistence/security structure.

## 4. Roles / ownership mental model

- **Ecofy** — lead-base qualification and financing outcomes/records.
- **iTarang** — qualified-lead pickup, assignment, follow-up, requirement assessment, offer/commercial closure and File creation.
- **EPC** — external quote/site/installation/commissioning evidence as defined in the BRD.
- **Platform** — state transitions, gates, RBAC, audit trail, notifications, persistence and integrations. It does not make underwriting/lending decisions or move funds.

## 5. Implementation sequence

### R1 — CRM foundation and lead conversion entry
Build:
- authentication / session controls / RBAC;
- tenant isolation and audit foundation;
- lead import and validation;
- S0 qualification;
- Hot/Warm handoff behavior exactly as frozen in BRD;
- S1 pickup queue;
- assignment / return-to-Ecofy;
- S2 follow-up and activities.

Exit R1 only after the applicable P0 UAT cases pass.

### R2 — assessment, offer and File
Build:
- meetings / EPC visit dependencies;
- S3 assessment, including manual/external path;
- calculator and recommendation behavior;
- `PENDING_TECHNICAL_DATA` versus `CUSTOM_REQUIRED` lineage;
- provisional quote path with mandatory recorded reason;
- EPC quote / eligibility / offer flow as defined by BRD;
- customer acceptance / OTP;
- File creation anchored to accepted quote lineage.

Exit R2 only after the applicable P0 UAT cases pass.

### R3 — financing, installation and asset lifecycle
Build:
- Ecofy financing state recording/integration;
- sanction / reroute / re-acceptance rules;
- parallel installation workflow;
- disbursement gate;
- active asset lifecycle / dashboards / admin / audit reports;
- scheduled jobs and retention rules.

Exit R3 only after all remaining P0 UAT cases pass.

## 6. Important frozen rules

The developer should not redesign these behaviors:

- Requirement Assessment cannot complete without an assessment record.
- Assessment may be calculator-based or manual/external; source is recorded.
- Standard recommendation requires sufficient compatible data as specified in BRD/seed.
- Missing technical data is **not** the same as custom-required.
- A provisional quote may be allowed where defined, but its basis/reason must be auditable.
- Permitted technical/workflow overrides are recorded; the platform does not silently rewrite them.
- Quote-price override is not supported in V1 where EPC price is authoritative.
- File creation is an auditable acceptance event anchored to accepted quote lineage.
- Financing decisions remain with Ecofy; installation/service execution remains with EPC.
- C&I calculator behavior follows BRD v1.4, not the older prototype.
- Commercial billing enforcement is off-platform unless the BRD explicitly states otherwise.

## 7. Out of scope / do not infer

Do not add functionality simply because it appears in the older prototype or Build Baseline. In particular, do not infer underwriting logic, lender decisioning, collections execution, money movement, detailed C&I techno-commercial modelling, IoT/risk behavior, or other excluded/future scope unless the BRD explicitly includes it.

## 8. Definition of done

A feature is not complete because the screen exists. It is complete when:

1. the BRD behavior and state/gate rules are implemented;
2. API behavior matches OpenAPI;
3. persistence/RLS/constraints match the schema;
4. defaults/config come from the seed rather than hard-coded ad hoc values;
5. audit events are produced where required; and
6. applicable P0 UAT scenarios pass.

P1 UAT scenarios should also pass before production handoff unless iTarang explicitly accepts an exception.

## 9. Reference-only material

`05_REFERENCE_ONLY/` contains:
- the Build Baseline / decision history;
- the system-design image;
- the frozen prototype HTML for UI/interaction reference.

These files are useful for context, but **they are non-authoritative for final behavior**.

---

**Developer rule:** if something is unclear, raise the exact BRD requirement ID / endpoint / table / UAT case. Do not solve ambiguity by inventing product behavior.
