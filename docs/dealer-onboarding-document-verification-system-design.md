# Dealer Onboarding — Document Verification & Extraction System Design

**Status:** Draft · **Date:** 2026-06-08 · **Owner:** iTarang Engineering
**Scope:** Automated processing of all documents collected through the dealer onboarding wizard.

---

## 1. Problem Statement

The dealer onboarding wizard collects **up to 14 documents** per dealer (8 mandatory uploads + up to 3 conditional firm documents + N partner/director photos + 1 system-generated signed agreement). Today these are stored in `dealer_onboarding_documents` and verified **manually** by the admin / sales-head verification team.

We need an automated layer that:

1. **Verifies** documents that have a government registry (is this GST / PAN / Udyam / bank account *real and valid*?).
2. **Extracts** structured data from documents that have **no** registry (ITR, bank statements, legal deeds).
3. Cross-checks extracted fields against what the dealer typed into the wizard.
4. Keeps cost predictable — target **≤ ₹15,000 / month for 500 dealers**.

---

## 2. Documents in Scope

| # | Document | Store key | Wizard step |
|---|----------|-----------|-------------|
| 1 | GST Certificate | `company.gstCertificate` | Company Details |
| 2 | Company PAN | `company.companyPanFile` | Company Details |
| 3 | Owner Photograph | `ownership.ownerPhoto` | Ownership & Banking |
| 4 | Partnership Deed *(conditional)* | `ownership.partnershipDeed` | Ownership & Banking |
| 5 | MOU Document *(conditional)* | `ownership.mouDocument` | Ownership & Banking |
| 6 | AOA Document *(conditional)* | `ownership.aoaDocument` | Ownership & Banking |
| 7 | Partner Photograph(s) *(per partner)* | `ContactCard.photo` | Ownership & Banking |
| 8 | Director Photograph(s) *(per director)* | `ContactCard.photo` | Ownership & Banking |
| 9 | Last 3 Years Company ITR | `compliance.itr3Years` | Financial & Compliance |
| 10 | Last 3 Months Bank Statement | `compliance.bankStatement3Months` | Financial & Compliance |
| 11 | 4 Undated Cheques | `compliance.undatedCheques` | Financial & Compliance |
| 12 | Passport Size Photograph | `compliance.passportPhoto` | Financial & Compliance |
| 13 | Udyam Registration Certificate | `compliance.udyamCertificate` | Financial & Compliance |
| 14 | Signed Agreement (LSP/Dealer) | `agreement.signedAgreementFile` | Agreement (Digio-generated) |

All persist as one row per file in **`dealer_onboarding_documents`** (keyed by `document_type`), saved via `/api/dealer-onboarding/save` and finalized at `/api/dealer/onboarding/submit`.

---

## 3. Decision: Hybrid (Decementro + Gemini Flash)

The three candidate platforms solve **two different problems**; no single one does both.

| Platform | Covers | Pricing | Cost / 500 dealers/mo |
|----------|--------|---------|------------------------|
| **Gemini Flash (LLM)** | All 8 incl. legal docs — *extraction only* | per token | ₹200 – ₹3,000 |
| **Document AI / Textract** | OCR all; structuring extra — *extraction only* | per page | ₹1,900 (OCR) → ₹40k+ (forms) |
| **Decentro (KYC API)** | GST / PAN / Udyam / cheque only — *verification* | per call | ₹7,500 – ₹12,500 |

**Chosen approach:** **Decentro (verify) + Gemini Flash (extract).**

### Why
- **Verification needs a registry.** Only Decentro can confirm a GSTIN/PAN/Udyam is genuine and active. An LLM can *read* the certificate but cannot validate it.
- **Extraction needs no registry.** ITR, bank statements, and legal deeds have no government source of truth — only readable data. Gemini Flash does this for cents.
- **Document AI / Textract is dominated.** It does extraction *only* (no verification), and its forms/tables parser balloons to ₹40k+/mo. Gemini Flash does the same job for ₹200–₹3,000. **Rejected.**
- **Zero new vendors.** Decentro is already integrated for KYC; Google Generative AI (Gemini) and Google Cloud Vision OCR are already in the stack.

### Cost summary
| Line item | Monthly (500 dealers) |
|-----------|------------------------|
| Decentro (≈4 registry-backed docs) | ₹7,500 – ₹12,500 |
| Gemini Flash (everything else) | ₹200 – ₹3,000 |
| **Total** | **≈ ₹8,000 – ₹15,000** |
| (Rejected) Textract forms route | ₹40,000+ |

---

## 4. Document → Tool Routing

| Document | Tool | Action |
|----------|------|--------|
| GST Certificate | **Decentro** | GST verify (GSTIN active, legal name match) |
| Company PAN | **Decentro** | PAN verify |
| Udyam Certificate | **Decentro** | Udyam verify |
| Undated Cheques / bank account | **Decentro** | Penny-drop: validate IFSC + account + beneficiary name |
| ITR (3 years) | **Gemini Flash** | Extract turnover, net profit; match PAN |
| Bank Statement (3 months) | **Gemini Flash** | Extract closing balances, account holder; cross-check vs cheque |
| Partnership Deed / MOU / AOA | **Gemini Flash** | Extract partner names, ownership %, execution dates |
| Owner / Partner / Director Photos | **Gemini Flash** *(optional)* | "Valid face photo?" check; Decentro face-match if liveness needed |
| Signed Agreement | **Neither** | Already produced & verified by Digio |

---

## 5. Architecture

```
                        ┌────────────────────────────────────────────┐
   Dealer Wizard  ──►   │  /api/dealer-onboarding/save                │
   (upload file)        │   → Supabase/S3 storage                     │
                        │   → dealer_onboarding_documents (1 row/file)│
                        └───────────────────┬────────────────────────┘
                                            │  (on submit / async job)
                                            ▼
                        ┌────────────────────────────────────────────┐
                        │   Document Processing Orchestrator          │
                        │   (BullMQ job per document_type)            │
                        └───────┬──────────────────────┬─────────────┘
                                │ registry-backed       │ no registry
                                ▼                        ▼
                   ┌────────────────────┐    ┌────────────────────────┐
                   │  Decentro Verify   │    │  Gemini Flash Extract   │
                   │  GST/PAN/Udyam/    │    │  ITR / bank stmt /      │
                   │  penny-drop        │    │  deed / MOU / AOA       │
                   └─────────┬──────────┘    └───────────┬────────────┘
                             │                            │
                             ▼                            ▼
                   verification_status           extracted_data (jsonb)
                   api_verification_results      + field cross-check
                             │                            │
                             └──────────┬─────────────────┘
                                        ▼
                        ┌────────────────────────────────────────────┐
                        │  Admin Dealer-Verification queue            │
                        │  - auto-pass / flag-for-review per doc      │
                        │  - exceptions surfaced to human reviewer    │
                        └────────────────────────────────────────────┘
```

### Existing tables/columns reused
`dealer_onboarding_documents` already has the right shape — no schema change required for the core flow:

- `verification_status` — set by Decentro / Gemini pass.
- `api_verification_results` (jsonb) — raw Decentro response.
- `extracted_data` (jsonb) — Gemini structured output.
- `verified_at`, `verified_by`, `rejection_reason` — human override.

---

## 6. Processing Flow

1. **Trigger** — on `/api/dealer/onboarding/submit`, enqueue one BullMQ job per uploaded document (reuse the existing call-worker queue pattern).
2. **Route** — orchestrator maps `document_type` → Decentro or Gemini (Section 4).
3. **Verify / Extract** — call the provider; store raw response in `api_verification_results`, structured fields in `extracted_data`.
4. **Cross-check** — compare extracted fields to wizard-entered values:
   - PAN on ITR == `company.companyPanNumber`
   - Beneficiary name on cheque == `ownership.beneficiaryName`
   - GST legal name == `company.companyName`
5. **Decide** — set per-document `verification_status`:
   - `verified` → all checks pass
   - `flagged` → mismatch / low confidence → routed to human reviewer
   - `rejected` → registry says invalid
6. **Surface** — admin dealer-verification screen shows the verdict + the specific mismatch, so reviewers only look at exceptions.

---

## 7. Failure & Edge Handling

- **Provider down / timeout** → mark `pending`, retry with backoff (BullMQ); never block dealer submission.
- **Low OCR/LLM confidence** → always fall through to human review rather than auto-reject.
- **Registry mismatch (e.g. GST inactive)** → hard `rejected`, reason stored in `rejection_reason`.
- **Conditional docs absent** (e.g. no partnership deed for sole proprietorship) → skip, not a failure.
- **Cost guardrail** → cap Gemini token usage per document; log dropped/oversized files instead of silently truncating.

---

## 8. Rollout Plan

1. **Phase 1 — Verify only.** Wire Decentro for GST/PAN/Udyam/penny-drop on the 4 registry-backed docs. Display results in admin queue (advisory, human still decides).
2. **Phase 2 — Extract.** Add Gemini Flash extraction for ITR / bank statement / legal deeds + field cross-check.
3. **Phase 3 — Auto-pass.** Once accuracy is proven, auto-mark clean documents `verified` and route only exceptions to humans.

---

## 9. Open Questions

- Which Decentro endpoints (GST / PAN / Udyam / penny-drop) are **already** integrated in `src/lib/kyc/` vs need building? *(audit before Phase 1)*
- Do we need face-match / liveness on the passport & partner/director photos, or is storage sufficient?
- SLA for verification — synchronous on submit, or async with the dealer notified later?

---

## 10. Decision Log

| Decision | Rationale |
|----------|-----------|
| Hybrid Decentro + Gemini Flash | Verification and extraction are distinct needs; no single tool covers both |
| Reject Document AI / Textract | Extraction-only, no verification, ₹40k+/mo — dominated by Gemini Flash |
| Reuse `dealer_onboarding_documents` jsonb columns | `extracted_data` + `api_verification_results` already exist; no migration needed |
| Reuse BullMQ worker | Background processing pattern already in production for calls |
