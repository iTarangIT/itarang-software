# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

iTarang is a full-stack dealer management CRM built with Next.js (App Router). It handles lead management, KYC verification, AI-powered sales calling, web scraping, and dealer onboarding — all in a single monolithic Next.js application.

## Commands

```bash
npm run dev              # Start Next.js + BullMQ call worker concurrently
npm run next             # Start Next.js dev server only
npm run worker           # Start BullMQ call worker only
npm run dev:no-turbo     # Dev without Turbopack
npm run build            # Production build
npm run start            # Production server on port 3000
npm run lint             # ESLint
npm run type-check       # TypeScript type checking (tsc --noEmit)
npm run db:push          # ⚠ DESTRUCTIVE: diff-pushes schema.ts to live DB. Never run against the shared sandbox or prod — write a drizzle/E-XXX_*.sql migration instead. See "Migrations" below.
```

## Tech Stack

- **Framework:** Next.js 16 (App Router, React 19, TypeScript 5)
- **Styling:** Tailwind CSS 4
- **State:** Zustand, TanStack React Query
- **Database:** PostgreSQL (Supabase) via Drizzle ORM
- **Auth:** Supabase Auth (SSR) with role-based middleware
- **Queue:** BullMQ + Upstash Redis for background call processing
- **AI:** Bolna AI (voice dialer), LangChain/LangGraph, Google Generative AI
- **Payments:** Razorpay
- **KYC:** Decentro (Aadhaar/PAN/Bank verification), DigiO (e-signature)
- **Scraping:** Firecrawl, Apify, Google Places API

## Architecture

### Source Layout (`src/`)

- **`app/`** — Next.js App Router pages and API routes
  - `(auth)/` — Login/logout route group
  - `(dashboard)/` — Protected dashboard routes grouped by role (admin, ceo, dealer-portal, business-head, finance-controller, etc.)
  - `api/` — ~194 REST API endpoints organized by feature (admin, auth, bolna, calls, dealer, kyc, leads, scraper, cron, etc.)
- **`components/`** — React components organized by feature domain (auth, dashboard, dealer-dashboard, kyc, leads, scraper, onboarding, shared, ui)
- **`lib/`** — Core services and utilities
  - `db/schema.ts` — Drizzle schema with 40+ tables
  - `db/index.ts` — Drizzle client instance
  - `supabase/` — Server, client, and admin Supabase clients
  - `ai/bolna_ai/` — Voice dialer integration (trigger, scheduler, webhook handler)
  - `ai/analysis/` — Call transcript analysis and scoring
  - `ai/langgraph/` — LangGraph agent implementation
  - `queue/` — BullMQ call queue, worker, and Redis connection
  - `scraper/` — Web scraping query builders and data sources
  - `kyc/` — KYC verification services
  - `ocr/` — OCR via Google Cloud Vision and Tesseract.js
- **`store/`** — Zustand stores
- **`types/`** — Shared TypeScript type definitions
- **`middleware.ts`** — Auth & role-based route protection

### Path Alias

`@/*` maps to `./src/*` (configured in tsconfig.json).

### Key Patterns

- **API routes** use Next.js route handlers (`route.ts` files) — no separate Express server.
- **Auth middleware** (`src/middleware.ts`) checks Supabase session and redirects based on user role.
- **Database access** uses Drizzle ORM — schema defined in `src/lib/db/schema.ts`, queried via the `db` instance from `src/lib/db/index.ts`.
- **Background processing** runs via a separate BullMQ worker process (`src/lib/queue/callWorker.ts`) started alongside Next.js in dev mode.
- **Validation** uses Zod schemas throughout API routes.

### User Roles

ceo, business_head, sales_head, sales_manager, sales_executive, finance_controller, inventory_manager, service_engineer, sales_order_manager, dealer, admin — each with distinct route access and dashboard views.

## Database

- PostgreSQL via Supabase (pooled connection)
- Drizzle ORM with schema in `src/lib/db/schema.ts`
- Migrations in `drizzle/` directory
- Config in `drizzle.config.ts` (uses `DATABASE_URL` env var)

### Migrations

The team uses **hand-written, named, idempotent SQL migration files** in `drizzle/` (see `E-002_nbfc_portal_credentials.sql`, `E-027_telemetry_ingestion_log.sql` for the pattern). Conventions:

- File name: `E-<number>_<short_snake_case_description>.sql`. Pick the next free `E-` number.
- Every DDL statement must be idempotent: `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. Wrap blocks in `DO $do$ BEGIN … EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip' END; $do$;` when the migration may run against a DB that doesn't yet have the table.
- Strictly **additive** — never `DROP COLUMN`, never narrow a type, never retroactively `SET NOT NULL` on a column with existing rows. If a destructive change is genuinely needed, escalate to the team and stage it across two migrations (additive write → deploy → backfill → second migration removes old).
- Update `src/lib/db/schema.ts` to mirror the migration so type-checking matches the DB. Source of truth is the migration file.
- **Do not run `npm run db:push` against the shared sandbox or production.** It is a diff-based tool that may DROP columns or `ALTER TYPE` data. The current `loan_sanctions` table already shows drift from past `db:push` use — the canonical record of what's actually in the DB has been lost. Don't compound it.
- `db:push` against a personal local DB you own is fine.
- To apply a new migration: open Supabase SQL editor (or the team's migration runner) and paste the file content. Re-running the same file should be a no-op.

## Deployment

- **Primary:** Vercel (configured in `vercel.json`)
- **Alternative:** PM2 (`ecosystem.config.js`)
- Vercel cron runs Bolna call scheduler every minute
- Production build uses `output: "standalone"`

## Important Notes

- Both Next.js server AND BullMQ worker must be running for full functionality in dev (`npm run dev` handles this).
- No formal test suite exists — no Jest/Vitest configuration.
- `legacy-vite/` contains old Vite-based codebase (pre-migration).
- TypeScript build errors are currently ignored in Next.js config (`ignoreBuildErrors: true`).
