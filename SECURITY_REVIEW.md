# Security Review — iTarang CRM

## Summary

The core plumbing is solid: SQL is parameterized, there is no XSS surface, no committed secrets, and no CORS exposure. The real risk is **authorization** — several API routes return or write sensitive data (Aadhaar, PAN, KYC docs) with no auth check at all, and two payment/KYC webhooks accept unsigned requests. These are exploitable today and should be fixed first.

| Severity | Count | Examples |
|----------|-------|----------|
| Critical | 5 | Unauth PII leak, unsigned webhooks, OTP bypass |
| High | 3 | Unauth uploads, unauth admin PDF, unauth writes |
| Medium | 7 | No rate limiting, PII in logs, debug routes, email backdoor |
| Low | 5 | Weak temp passwords, verbose errors, `xlsx` advisory |

**Top 5 to fix now:**
1. `GET /api/kyc/[leadId]/access-check` — returns Aadhaar/PAN/DOB/address for any lead, no auth.
2. `GET /api/kyc/[leadId]/documents` — returns KYC docs for any lead, no auth.
3. DigiO webhook — no signature; anyone can forge "signed consent" / NBFC activation.
4. Legacy Bolna webhook — no signature; anyone can forge calls and trigger outbound dialing.
5. Hardcoded OTP `123456` returned in the API response when MSG91 is not configured.

---

## 1. Authentication & Session Management

- **[Critical] OTP bypass.** When `MSG91_AUTH_KEY` is unset the OTP is hardcoded `123456` and returned in the response as `_devOtp`. This is gated on the env var, **not** on `NODE_ENV`, so a production deploy missing the key makes OTP verification trivial. `src/app/api/lead/[id]/step-5/send-otp/route.ts`
- **[Low] Predictable temp passwords.** Uses `Math.random()`, not a crypto RNG. `src/lib/auth/generateTemporaryPassword.ts`
- **[Low] Redundant password store.** A bcrypt copy is written to `users.password_hash` alongside Supabase Auth. No login path verifies it — it is extra credential exposure for no benefit. `src/app/api/auth/change-password/route.ts`
- **[Medium] Weak password policy.** `change-password` only checks `if(!password)` — no length/complexity rule before the update.
- Auth itself is Supabase SSR + role middleware. No JWT library, no custom crypto. Good.

## 2. Authorization / Access Control

- **[Critical] Unauthenticated PII (IDOR).** `GET /api/kyc/[leadId]/access-check` returns Aadhaar, PAN, DOB, addresses, and phone for **any** leadId — no auth, no ownership check. *(verified)* `src/app/api/kyc/[leadId]/access-check/route.ts`
- **[Critical] Unauthenticated KYC docs.** `GET /api/kyc/[leadId]/documents` returns all KYC documents for any leadId, no auth. *(verified)* `src/app/api/kyc/[leadId]/documents/route.ts`
- **[High] Unauthenticated admin endpoint.** `api/admin/kyc/[leadId]/consent/[consentId]/fetch-pdf` fetches and stores signed-consent PDFs with no auth/role check.
- **[High] Unauthenticated writes.** `leads/import` (bulk insert), `dealer-leads` (insert), `leads/[id]/summary` (write), `leads/[id]/call-logs` (read) — all with no auth.
- **[Medium] IDOR on lead update.** `PUT /api/leads/[id]` is role-gated, but any `sales_executive` can update **any** lead by id — no check that the lead is assigned to them. `src/app/api/leads/[id]/route.ts`
- **[Medium] Fail-open role check.** `requireRole` synthesizes `role:"user"` on a DB miss instead of denying. Cron routes allow unauthenticated access when `CRON_SECRET` is unset. `src/lib/auth-utils.ts`
- **[Medium] Hardcoded email backdoor.** `email === "sanchit@itarang.com"` is hardcoded to grant NBFC activation. `src/app/api/admin/nbfc/[nbfcId]/activate/route.ts:174`

**Fix pattern:** every route above should call an existing helper (`requireAuth()` / `requireRole()` from `src/lib/auth-utils.ts`) and, for by-id access, filter on ownership (e.g. `dealer_id` / assigned user) as `dealer/loan-facilitation/[id]` already does.

## 3. Input Validation & Injection

- **SQL injection — none found.** Drizzle parameterization is used consistently. All `sql.raw()` sites take hardcoded, whitelisted, or sanitized input (e.g. `date_trunc` granularity is whitelisted to `month|week|day`).
- **XSS — none found.** Zero `dangerouslySetInnerHTML` in the codebase; React escaping is relied on.
- **SSRF — none found.** No route fetches an attacker-supplied URL. Webhook targets are compile-time enums; scraper URLs come from Firecrawl's own results, not user input.
- **[Medium] Unauthenticated log sink.** `internal/log-client-error` writes arbitrary body fields to logs with no auth — log-spam / log-injection vector.
- Zod is used in 242 of 256 routes that read a body — strong coverage. Gaps are mostly KYC/callback routes using ad-hoc `if(!field)` checks.

## 4. Data Exposure

- **[Medium] PII in logs (DPDPA concern).** Plaintext PAN, full Aadhaar/Decentro payloads, and the OTP are written to server logs:
  - `src/app/api/admin/kyc/[leadId]/ocr/route.ts:330` (PAN)
  - `src/app/api/kyc/[leadId]/decentro/aadhaar-otp/route.ts:22` (Aadhaar payload)
  - `src/app/api/admin/kyc/[leadId]/aadhaar/digilocker/status/[transactionId]/route.ts:141` (eAadhaar JSON)
  - `src/lib/kyc/pan-verification.ts:232`
  - `send-otp` MSG91-unset branch (OTP)
- **[Low] Verbose errors.** Several routes return raw `error.message`, bypassing `sanitizeDbError` — can leak SQL fragments / provider internals. Seen in bolna webhook, kyc upload, send-otp, dealer-documents.
- **Secrets — clean.** No `.env` files committed, no hardcoded provider keys in source; `.gitignore` is thorough; lockfile committed. Responses generally project columns (no `password_hash` returned anywhere).

## 5. API Security

- **[Medium] No rate limiting.** No limiter library or middleware anywhere. The only throttle is a per-session OTP counter (3 sends / 30 min). Login, KYC, and AI-call routes have nothing — brute-force / abuse exposure.
- **[Medium] Debug/test routes exposed in prod.** `api/debug/*` dumps `information_schema` and can alter tables; `api/test-email` contains a hardcoded `password: "Temp@12345"`; also `test-aws`, `test-sheet`, `bolna-test`. These should be removed or env-gated.
- **CORS — safe.** No `Access-Control-Allow-*` headers set; same-origin only.
- **Webhook signatures — mixed:**
  - Verified (good): Razorpay QR, Razorpay EMI, WhatsApp, modern Bolna.
  - **[Critical] Not verified:** DigiO (`api/webhooks/digio/route.ts`) — forge signed-consent / NBFC activation keyed only on a guessable `document_id`. Legacy Bolna (`api/webhooks/bolna/route.ts`) — forge call data and trigger outbound calls.

## 6. File Uploads

- **[High] Unauthenticated upload with service-role key.** `api/uploads/dealer-documents/route.ts` has no auth and uses `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS). The `dealer-documents` bucket is also served with no auth. File type/size are validated, and keys use random UUIDs, which limits the damage — but anyone can upload.
- **[Low] KYC upload — no file-type check.** `api/kyc/[leadId]/upload-document/route.ts` validates size only, not type/extension. User-controlled `leadId` and `docType` are put into the storage key without sanitization (low risk on Supabase's literal keys, but no defense-in-depth).
- The file-**serving** proxy (`api/files/[bucket]/[...path]`) has a correct path-traversal guard (`..`, null byte, absolute path rejected). Good.

## 7. Third-Party Dependencies

- **[Low] `xlsx@0.18.5` (SheetJS).** The npm-registry build has known prototype-pollution / ReDoS advisories with no fix on the registry — migrate to the vendor CDN build or replace.
- `next@16.1.3`, `react@19.2.3` — current. No `next-auth`, no `jsonwebtoken`, no standalone `axios`.
- `package-lock.json` committed, but **no `npm audit`** step in CI/scripts — recommend adding one.
- **[Low] `typescript.ignoreBuildErrors: true`** in `next.config.ts` — type errors don't fail the build; not a vuln but weakens the safety net.

## 8. Business Logic Flaws

- The **unsigned DigiO webhook** (Section 5) is the key business-logic risk: forging a "signed consent" or "agreement completed" corrupts KYC/loan integrity and can activate NBFCs.
- The **hardcoded email backdoor** and **fail-open role resolution** (Section 2) are privilege paths.
- **IDOR on lead update** (Section 2) lets one sales rep overwrite another rep's leads.
- No multi-tenant contact-export leak was found beyond the by-id IDOR issues already listed.

---

## Good controls (worth keeping)

- SQL parameterized throughout; no user-controlled `sql.raw`.
- No XSS surface (no `dangerouslySetInnerHTML`).
- No raw-body mass assignment — explicit field mapping into inserts.
- No SSRF — fetch targets are enums / provider results, not user URLs.
- No committed secrets; thorough `.gitignore`; lockfile present.
- No CORS exposure (same-origin).
- Signature verification on Razorpay, EMI, WhatsApp, modern Bolna.
- Path-traversal guard on the file-serving proxy.

## Suggested fix order

1. Add auth + ownership checks to the unauthenticated KYC/PII/write routes (Section 2).
2. Add signature verification to the DigiO and legacy Bolna webhooks (Section 5).
3. Remove or hard-gate the hardcoded OTP path and the `debug/*` + `test-*` routes.
4. Strip PAN/Aadhaar/OTP from logs; route all errors through `sanitizeDbError`.
5. Add rate limiting (login, OTP, KYC), remove the email backdoor, fail-closed role checks.
6. Replace `xlsx`, add `npm audit` to CI.
