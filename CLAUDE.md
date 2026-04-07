# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Itarang CRM — a full-stack EV battery distribution CRM platform built with Next.js (App Router). Manages leads, deals, inventory, dealer onboarding, payments, KYC, AI voice calling, and workflow automation across 11 role-based dashboards.

## Commands

```bash
npm run dev              # Dev server with Turbopack (port 3000)
npm run dev:no-turbo     # Dev server without Turbopack
npm run build            # Production build (standalone output)
npm start                # Production server
npm run lint             # ESLint
npm run type-check       # TypeScript checking (tsc --noEmit)
npm run db:push          # Push Drizzle schema to Postgres
```

Production deployment uses PM2 on Hostinger VPS (`ecosystem.config.js`).

## Tech Stack

- **Next.js 16** (App Router) + React 19 + TypeScript 5
- **Drizzle ORM** with PostgreSQL (AWS RDS primary, Supabase fallback)
- **Supabase Auth** for authentication + Next.js middleware for role-based routing
- **TailwindCSS 4** with teal/emerald brand theme
- **Zustand** for client state, **React Query** for server state
- **React Hook Form + Zod** for form validation

## Architecture

### Routing & Auth
- `src/middleware.ts` intercepts all requests, validates Supabase JWT, resolves user role, and redirects to the appropriate role-specific dashboard under `src/app/(dashboard)/`.
- 11 roles: `ceo`, `admin`, `business_head`, `sales_head`, `sales_manager`, `sales_executive`, `sales_order_manager`, `finance_controller`, `inventory_manager`, `service_engineer`, `dealer`.
- Role normalization and path mapping lives in `src/lib/roles.ts`.

### API Layer
- API routes in `src/app/api/` use a standard pattern: Zod validation → `requireRole()` auth check → business logic → `successResponse()`/`errorResponse()`.
- Error handling wrapper: `withErrorHandler` in `src/lib/api-utils.ts`.
- N8N webhooks fire on key events (lead creation, approval changes, etc.).

### Database
- Schema with 60+ tables defined in `src/lib/db/schema.ts` (Drizzle ORM).
- Connection config in `src/lib/db/connection.ts` — dual-database: AWS RDS (primary) + Supabase Postgres.
- Migrations output to `/drizzle` directory. Config in `drizzle.config.ts`.
- Types inferred from schema in `src/types/database.ts`.

### Key Integrations
- **Bolna AI** (`src/lib/bolna.ts`, `src/lib/ai/`) — voice calling / AI dialer
- **Digio** (`src/lib/digio.ts`) — e-signatures
- **Decentro** — KYC verification
- **Razorpay** (`src/lib/razorpay.ts`) — payments
- **IntelliCar** — fleet telematics
- **AWS S3** (`src/lib/aws/`) — document storage
- **FireCrawl** (`src/lib/firecrawl.ts`) — web scraping
- **Google Cloud Vision + Tesseract.js** — OCR

### Core Workflows
- **Lead lifecycle**: creation → N8N webhook → Bolna AI call → qualification → deal → KYC (Decentro) → e-sign (Digio) → payment (Razorpay) → order
- **Dealer onboarding**: multi-step wizard (Zustand state in `src/store/onboardingStore.ts`) → doc upload (S3) → KYC → agreement signing → approval
- **Approvals**: multi-level workflow tracked in `approvals` table with email notifications
- **Cron jobs** (configured in `vercel.json`): AI dialer at 3 AM, scraper at 4 AM daily

### Path Alias
`@/*` maps to `./src/*` (configured in `tsconfig.json`).
