# Itarang CRM Platform — CAPEX & OPEX Cost Analysis

**Version:** 1.0
**Date:** March 30, 2026
**Currency:** INR (USD conversion at ₹85 = $1 where applicable)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Assumptions](#assumptions)
3. [CAPEX — One-Time Capital Expenditure](#capex--one-time-capital-expenditure)
4. [OPEX — Monthly Operating Expenditure](#opex--monthly-operating-expenditure)
   - [Hosting — Hostinger](#41-hosting--hostinger)
   - [AWS Infrastructure](#42-aws-infrastructure--database--storage)
   - [Third-Party API Services](#43-third-party-api-services)
   - [Personnel](#44-personnel)
   - [Development Tools](#45-development-tools)
   - [Miscellaneous & Contingency](#46-miscellaneous--contingency)
5. [Telemetry Infrastructure Deep-Dive](#5-telemetry-infrastructure-deep-dive)
6. [Monthly & Annual Cost Summary](#6-monthly--annual-cost-summary)
7. [Year 2 Scaling Projections](#7-year-2-scaling-projections)
8. [Cost Optimization Recommendations](#8-cost-optimization-recommendations)
9. [Notes & Disclaimers](#9-notes--disclaimers)

---

## Executive Summary

Itarang CRM is a B2B platform for EV battery distribution (3-wheeler segment) integrating KYC verification, e-signatures, AI voice calling, fleet telematics, payment processing, dealer scraping, and workflow automation across 10+ external APIs and 40+ API routes.

This document covers all infrastructure, API, personnel, and tooling costs required to run the platform. The system also needs to ingest and store **30-second interval telemetry data for 22,000 vehicles** over 6 months — a significant data infrastructure requirement generating ~63 million records/day and ~3.4 TB over the retention period.

| | Amount (INR) |
|---|---|
| **CAPEX (One-Time)** | **₹2,37,000** |
| **OPEX (Monthly)** | **₹2,59,300** |
| **OPEX (Annual)** | **₹31,11,600** |
| **Year 1 Total** | **₹33,48,600** |

---

## Assumptions

| Parameter | Value |
|-----------|-------|
| Stage | Early-stage B2B SaaS |
| Active Dealers | ~50–200 |
| Leads/month | ~500–2,000 |
| KYC Verifications/month | ~200 |
| AI Voice Calls/month | ~500 |
| E-Signatures/month | ~50 |
| Payment Transactions/month | ~100 |
| Tracked Vehicles | 22,000 |
| Telemetry Interval | 30 seconds |
| Telemetry Retention | 6 months (hot), archival after |
| Team Size | 2 coders + 2 consultants |
| Region | India-based operations |
| INR/USD Rate | ₹85 = $1 |

---

## CAPEX — One-Time Capital Expenditure

| # | Item | Cost (INR) | Notes |
|---|------|-----------|-------|
| 1 | Domain Registration (2 years) | 2,000 | .in or .com domain |
| 2 | SSL Certificate | 0 | Free via Let's Encrypt |
| 3 | Development Laptops (2 coders) | 1,60,000 | ₹80,000 each, mid-range dev machines |
| 4 | DigiO Integration Setup Fee | 10,000 | One-time onboarding/integration fee |
| 5 | IntelliCar Platform Onboarding | 25,000 | Device provisioning, API integration setup |
| 6 | AWS Initial Setup & Data Migration | 40,000 | RDS provisioning, schema migration from Supabase, S3 bucket setup, IAM configuration |
| | **CAPEX Total** | **₹2,37,000** | |

---

## OPEX — Monthly Operating Expenditure

### 4.1 Hosting — Hostinger

| Service | Plan | Monthly (INR) | Annual (INR) | Notes |
|---------|------|--------------|-------------|-------|
| Hostinger Cloud VPS (Next.js App) | KVM 4 (4 vCPU, 8GB RAM) | 2,500 | 30,000 | Next.js standalone build, PM2 process manager, serves frontend + API routes |
| Hostinger VPS (N8N Automation) | KVM 2 (2 vCPU, 4GB RAM) | 1,000 | 12,000 | Self-hosted N8N workflow engine, 24+ webhook event types |
| **Subtotal** | | **3,500** | **42,000** | |

### 4.2 AWS Infrastructure — Database & Storage

#### Application Database (CRM)

| Resource | Spec | Monthly (INR) | Annual (INR) | Notes |
|----------|------|--------------|-------------|-------|
| RDS PostgreSQL | db.t3.medium (2 vCPU, 4GB RAM) | 8,500 | 1,02,000 | 60+ tables, Drizzle ORM, CRM application data |
| RDS Storage (gp3) | 50 GB | 850 | 10,200 | Application data with moderate growth |
| Automated Backups | 7-day retention | 500 | 6,000 | Point-in-time recovery |

#### Telemetry Database (Vehicle Data)

| Resource | Spec | Monthly (INR) | Annual (INR) | Notes |
|----------|------|--------------|-------------|-------|
| RDS PostgreSQL + TimescaleDB | db.r6g.xlarge (4 vCPU, 32GB RAM) | 35,000 | 4,20,000 | High-write workload: ~733 inserts/sec sustained, hypertable partitioning |
| RDS Storage (gp3) | 600 GB initial → 3.4 TB over 6 months | 8,500 | 1,02,000 | ~570 GB/month growth, gp3 with 3000 IOPS baseline |
| RDS IOPS (provisioned) | 6,000 IOPS | 4,000 | 48,000 | Required for sustained write throughput |

#### Storage & Data Transfer

| Resource | Spec | Monthly (INR) | Annual (INR) | Notes |
|----------|------|--------------|-------------|-------|
| S3 Standard (Documents) | ~50 GB | 100 | 1,200 | Dealer KYC docs, agreements, PDFs |
| S3 Infrequent Access (Telemetry Archive) | ~500 GB after 6 months | 1,500 | 18,000 | Compressed telemetry data post-retention |
| S3 Glacier (Long-term Archive) | Growing over time | 500 | 6,000 | Regulatory compliance storage |
| Data Transfer (Outbound) | ~100 GB/month | 1,500 | 18,000 | API responses, dashboard queries |
| **AWS Subtotal** | | **₹61,450** | **₹7,31,400** | |

### 4.3 Third-Party API Services

#### Decentro — KYC & Identity Verification

| API Endpoint | Volume/month | Rate | Monthly (INR) | Annual (INR) |
|-------------|-------------|------|--------------|-------------|
| Aadhaar OTP Verification | 200 | ₹3/verification | 600 | 7,200 |
| PAN Validation | 200 | ₹2/verification | 400 | 4,800 |
| Bank Account Verification (Penny Drop) | 150 | ₹3/verification | 450 | 5,400 |
| Document OCR (PAN/Aadhaar) | 100 | ₹5/document | 500 | 6,000 |
| Face Match / Biometric | 100 | ₹5/match | 500 | 6,000 |
| Platform Fee (base) | — | Fixed | 2,500 | 30,000 |
| **Decentro Subtotal** | | | **4,950** | **59,400** |

#### DigiO — E-Signatures & Agreements

| Service | Volume/month | Rate | Monthly (INR) | Annual (INR) |
|---------|-------------|------|--------------|-------------|
| E-Signature Requests | 50 | ₹30/signature | 1,500 | 18,000 |
| Platform Access Fee | — | Fixed | 2,000 | 24,000 |
| **DigiO Subtotal** | | | **3,500** | **42,000** |

#### Bolna — AI Voice Calling

| Service | Volume/month | Rate | Monthly (INR) | Annual (INR) |
|---------|-------------|------|--------------|-------------|
| AI Outbound Calls | 500 calls (~3 min avg) | ₹6/min | 9,000 | 1,08,000 |
| **Bolna Subtotal** | | | **9,000** | **1,08,000** |

> **Note:** Bolna is the largest API cost driver. Optimizing average call duration from 3 min to 2 min saves ₹3,000/month.

#### Razorpay — Payment Gateway

| Service | Volume/month | Rate | Monthly (INR) | Annual (INR) |
|---------|-------------|------|--------------|-------------|
| UPI QR Code Payments | 100 txns @ avg ₹5,000 | 2% TDR | 10,000 | 1,20,000 |
| **Razorpay Subtotal** | | | **10,000** | **1,20,000** |

> **Note:** Razorpay TDR is effectively a pass-through cost — charged as facilitation fee to dealers/customers. Net cost to Itarang may be ₹0 if fully passed through.

#### IntelliCar — Fleet Telematics

| Service | Volume/month | Rate | Monthly (INR) | Annual (INR) |
|---------|-------------|------|--------------|-------------|
| Vehicle Tracking (22,000 devices) | 22,000 devices | ₹15/device/month | 3,30,000 | 39,60,000 |
| **IntelliCar Subtotal** | | | **3,30,000** | **39,60,000** |

> **Note:** IntelliCar pricing at scale (22K devices) would typically involve a negotiated enterprise contract. The ₹15/device rate reflects a bulk discount from the standard ₹150/device retail rate. **Actual enterprise pricing should be negotiated directly.** If Itarang only manages the data pipeline (not the device subscription), this cost may be borne by OEMs/fleet operators, not Itarang.

#### Other API Services

| Service | Plan/Volume | Monthly (INR) | Annual (INR) | Notes |
|---------|------------|--------------|-------------|-------|
| Firecrawl (Web Scraping) | Starter — 3,000 credits | 1,600 | 19,200 | Dealer discovery from JustDial, IndiaMART etc. |
| OpenAI GPT-4o | ~100K tokens/day via LangChain | 1,250 | 15,000 | Lead qualification, transcript analysis |
| Google Cloud Vision (OCR) | ~500 requests/month | 0 | 0 | Free tier covers this volume (1,000 free/month) |
| EmailJS | 200 emails/month | 0 | 0 | Free tier (200/month) |
| **Other APIs Subtotal** | | **2,850** | **34,200** |

#### API Services — Total Summary

| API Provider | Monthly (INR) | Annual (INR) |
|-------------|--------------|-------------|
| Decentro (KYC) | 4,950 | 59,400 |
| DigiO (E-Signatures) | 3,500 | 42,000 |
| Bolna (AI Voice) | 9,000 | 1,08,000 |
| Razorpay (Payments) | 10,000 | 1,20,000 |
| IntelliCar (Telematics)* | 3,30,000 | 39,60,000 |
| Firecrawl + OpenAI + Others | 2,850 | 34,200 |
| **API Total (with IntelliCar)** | **₹3,60,300** | **₹43,23,600** |
| **API Total (without IntelliCar)** | **₹30,300** | **₹3,63,600** |

> *IntelliCar cost depends on commercial model — see note above. If borne by OEMs/fleet operators, exclude from Itarang OPEX.

### 4.4 Personnel

| Role | Count | Monthly/Person (INR) | Monthly Total (INR) | Annual (INR) |
|------|-------|---------------------|--------------------|--------------|
| Full-Stack Developers | 2 | 18,000 | 36,000 | 4,32,000 |
| Consultants (Part-Time) | 2 | 40,000 | 80,000 | 9,60,000 |
| **Personnel Subtotal** | | | **1,16,000** | **13,92,000** |

> Consultant scope: Business strategy + technical architecture advisory (~15–20 hrs/month each).
> Developer costs exclude statutory benefits (PF, ESI, gratuity) which add ~15–20% if applicable.

### 4.5 Development Tools

| Tool | Plan | Monthly (INR) | Annual (INR) | Notes |
|------|------|--------------|-------------|-------|
| Claude Code | Max Plan | 24,000 | 2,88,000 | AI-assisted development — 1 seat |
| GitHub | Free | 0 | 0 | Repository hosting, basic CI |
| **Dev Tools Subtotal** | | **24,000** | **2,88,000** | |

### 4.6 Miscellaneous & Contingency

| Item | Monthly (INR) | Annual (INR) | Notes |
|------|--------------|-------------|-------|
| Domain Renewal (amortized) | 85 | 1,000 | Annual cost spread monthly |
| Error Monitoring (Sentry) | 0 | 0 | Free tier for small teams |
| Logging & Analytics | 0 | 0 | Included in Hostinger / custom |
| Contingency Buffer (10%) | 23,500 | 2,82,000 | API overages, scaling spikes, unforeseen costs |
| **Misc Subtotal** | **23,585** | **2,83,000** | |

---

## 5. Telemetry Infrastructure Deep-Dive

### Data Volume Calculations

| Metric | Value |
|--------|-------|
| Vehicles | 22,000 |
| Data Interval | Every 30 seconds |
| Readings per vehicle per day | 2,880 |
| **Total records per day** | **63,360,000 (~63.4M)** |
| Total records per month | ~1.9 billion |
| Total records over 6 months | ~11.4 billion |
| Avg record size (raw) | ~300 bytes |
| **Raw data per day** | **~19 GB** |
| **Raw data per month** | **~570 GB** |
| **Raw data over 6 months** | **~3.4 TB** |
| Sustained write throughput | **~733 inserts/second** |

### Recommended Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Data Ingestion Layer                         │
│  IntelliCar API → Batch Fetch (every 30s) → Buffer Queue      │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│              HOT STORAGE (0–6 months)                           │
│  AWS RDS PostgreSQL + TimescaleDB Extension                    │
│  Instance: db.r6g.xlarge (4 vCPU, 32GB RAM)                   │
│  Storage: gp3, 6000 IOPS provisioned                          │
│  Features:                                                     │
│  • Hypertable partitioning by time (daily chunks)              │
│  • Compression after 7 days (10:1 ratio typical)               │
│  • Continuous aggregates for dashboard queries                 │
│  • Retention policy: auto-drop chunks > 6 months              │
└──────────────────────────┬──────────────────────────────────────┘
                           │ After 6 months
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│              WARM STORAGE (6–12 months)                         │
│  Amazon S3 Infrequent Access                                   │
│  • Parquet format (columnar, compressed)                       │
│  • Queryable via Athena if needed                              │
│  • ~90% cost reduction vs hot storage                          │
└──────────────────────────┬──────────────────────────────────────┘
                           │ After 12 months
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│              COLD STORAGE (12+ months)                          │
│  Amazon S3 Glacier                                             │
│  • Regulatory compliance / audit trail                         │
│  • ₹0.30/GB/month                                             │
└─────────────────────────────────────────────────────────────────┘
```

### Telemetry Record Schema (estimated)

| Field | Type | Size |
|-------|------|------|
| timestamp | TIMESTAMPTZ | 8 bytes |
| vehicle_id | UUID | 16 bytes |
| device_id | VARCHAR | 20 bytes |
| latitude | DOUBLE | 8 bytes |
| longitude | DOUBLE | 8 bytes |
| speed_kmh | FLOAT | 4 bytes |
| battery_soc | FLOAT | 4 bytes |
| battery_soh | FLOAT | 4 bytes |
| battery_voltage | FLOAT | 4 bytes |
| battery_current | FLOAT | 4 bytes |
| battery_temp | FLOAT | 4 bytes |
| odometer_km | FLOAT | 4 bytes |
| can_data (JSONB) | JSONB | ~200 bytes |
| **Total (approx)** | | **~290 bytes** |

### Compression Benefits (TimescaleDB)

| State | Storage per month | Cost/month (INR) |
|-------|------------------|-----------------|
| Uncompressed (raw) | ~570 GB | ~9,500 (gp3) |
| Compressed (after 7 days) | ~60–80 GB | ~1,200 (gp3) |
| Effective 6-month footprint | ~500–700 GB | Included in RDS sizing |

> TimescaleDB native compression typically achieves 8–10x compression on time-series data, significantly reducing the effective storage footprint.

---

## 6. Monthly & Annual Cost Summary

### Scenario A: Itarang Bears All Costs (Including IntelliCar)

| Category | Monthly (INR) | Annual (INR) | % of Total |
|----------|--------------|-------------|-----------|
| Hosting (Hostinger) | 3,500 | 42,000 | 1% |
| AWS Infrastructure | 61,450 | 7,31,400 | 20% |
| Third-Party APIs | 3,60,300 | 43,23,600 | 56% |
| Personnel | 1,16,000 | 13,92,000 | 18% |
| Development Tools | 24,000 | 2,88,000 | 4% |
| Miscellaneous + Contingency | 23,585 | 2,83,000 | 4% |
| **Total OPEX** | **₹5,88,835** | **₹70,60,000** | **100%** |
| | | | |
| **CAPEX (One-Time)** | — | **₹2,37,000** | |
| **Year 1 Grand Total** | — | **₹72,97,000** | |

### Scenario B: IntelliCar Cost Borne by OEMs/Fleet Operators (Recommended)

| Category | Monthly (INR) | Annual (INR) | % of Total |
|----------|--------------|-------------|-----------|
| Hosting (Hostinger) | 3,500 | 42,000 | 1% |
| AWS Infrastructure | 61,450 | 7,31,400 | 24% |
| Third-Party APIs | 30,300 | 3,63,600 | 12% |
| Personnel | 1,16,000 | 13,92,000 | 45% |
| Development Tools | 24,000 | 2,88,000 | 9% |
| Miscellaneous + Contingency | 23,585 | 2,83,000 | 9% |
| **Total OPEX** | **₹2,58,835** | **₹31,00,000** | **100%** |
| | | | |
| **CAPEX (One-Time)** | — | **₹2,37,000** | |
| **Year 1 Grand Total** | — | **₹33,37,000** | |

### Cost Distribution (Scenario B — without IntelliCar)

```
Personnel (45%)        ████████████████████████████████████████████░░  ₹13.92L/yr
AWS Infrastructure (24%) ██████████████████████████░░░░░░░░░░░░░░░░░░  ₹7.31L/yr
Third-Party APIs (12%)  █████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ₹3.64L/yr
Dev Tools (9%)         ██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ₹2.88L/yr
Contingency (9%)       ██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ₹2.83L/yr
Hosting (1%)           ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ₹0.42L/yr
```

---

## 7. Year 2 Scaling Projections

Assuming 2x growth in dealers, leads, and transaction volumes:

| Category | Year 1 (Monthly) | Year 2 (Monthly) | Change |
|----------|-----------------|-----------------|--------|
| Hosting (Hostinger) | 3,500 | 5,000 | Upgrade to higher VPS tier |
| AWS (App DB) | 9,850 | 15,000 | Scale to db.t3.large |
| AWS (Telemetry DB) | 47,500 | 55,000 | Storage growth + IOPS |
| AWS (S3 + Transfer) | 4,100 | 8,000 | Archival data accumulates |
| Decentro | 4,950 | 8,500 | 400 KYC verifications/month |
| DigiO | 3,500 | 5,500 | 100 signatures/month |
| Bolna | 9,000 | 18,000 | 1,000 calls/month |
| Razorpay | 10,000 | 20,000 | 200 transactions/month |
| Firecrawl + OpenAI | 2,850 | 5,000 | Higher scraping + AI usage |
| Personnel | 1,16,000 | 1,34,000 | +1 junior developer at ₹18K |
| Claude Code | 24,000 | 24,000 | Same plan |
| Contingency (10%) | 23,500 | 30,000 | Scales with total |
| **Year 2 Monthly OPEX** | | **₹3,28,000** | |
| **Year 2 Annual OPEX** | | **₹39,36,000** | |

> Year 2 projection excludes IntelliCar device costs (assumed OEM-borne).

---

## 8. Cost Optimization Recommendations

### Quick Wins

1. **Bolna Call Duration** — Optimize AI agent scripts to reduce avg call from 3 min to 2 min → saves ₹3,000/month (₹36,000/year)
2. **Razorpay Pass-Through** — Ensure 100% of TDR is passed to dealers as facilitation fee → saves ₹10,000/month
3. **TimescaleDB Compression** — Enable aggressive compression on telemetry data after 24 hours → reduces storage costs by 80%
4. **Decentro Volume Discount** — Negotiate volume pricing after 3 months of usage data → potential 20–30% discount
5. **EmailJS → Nodemailer** — Nodemailer (already in codebase) with SMTP for higher volumes at near-zero cost

### Medium-Term

6. **Reserved Instances (AWS)** — Commit to 1-year reserved instances for RDS → saves ~30% (₹1.5L/year)
7. **S3 Lifecycle Policies** — Automate IA → Glacier transitions → saves on long-term storage
8. **Batch Telemetry Writes** — Buffer and batch-insert telemetry data (every 5 min batch vs real-time) → reduces IOPS requirements
9. **DigiO Volume Tier** — At 100+ signatures/month, negotiate enterprise pricing

### Long-Term

10. **Self-Hosted N8N → Temporal/Inngest** — If workflow complexity grows, consider purpose-built orchestration
11. **OpenAI → Self-Hosted LLM** — At scale, consider fine-tuned open-source model for lead qualification
12. **Multi-Region CDN** — Add CloudFront if user base expands beyond India

---

## 9. Notes & Disclaimers

- All API pricing based on publicly available rates as of March 2026
- INR/USD conversion at ₹85 = $1
- Razorpay TDR is effectively pass-through if facilitation fees are charged to customers
- IntelliCar enterprise pricing depends on fleet partnership terms — rate shown is estimated bulk rate
- Personnel costs shown are gross pay; statutory benefits (PF, ESI, gratuity) add ~15–20% if applicable
- AWS pricing based on Mumbai region (ap-south-1) on-demand rates
- TimescaleDB is available as a PostgreSQL extension on RDS (community edition, free)
- Telemetry storage estimates assume ~300 bytes/record uncompressed; actual may vary based on CAN data payload
- Year 2 projections assume organic 2x growth; rapid scaling may require re-architecture
- All costs are estimates and should be validated against actual vendor quotes

---

*Document generated for financial planning purposes. Review with actual vendor contracts before budgeting.*


  What This BRD Is About                                                                                                                                           
                                                                                                                                                                   
  Your BRD defines two workflows for KYC Step 2, both requiring admin approval before a lead can proceed:
                                                                                                                                                                   
  1. Customer Consent (gate before anything else)       

  - Digital path: Send SMS/WhatsApp link → Customer signs with Aadhaar OTP (eSign) → Admin reviews signed PDF → Approves
  - Manual path: Generate consent PDF → Dealer prints → Customer signs physically → Dealer uploads scan → Admin reviews → Approves
  - Critical rule: Lead is BLOCKED until admin approves consent

  2. Document Upload (two-stage)

  - Stage 1 (Dealer): Upload 11 documents (finance) — simple upload, no API verification
  - Stage 2 (Admin): Admin runs OCR + API checks, approves/rejects each doc — dealer cannot proceed until ALL verified

  What Already Exists in Your Codebase

  Good news — about 60% of the infrastructure exists: consentRecords table, consent APIs (send/generate/upload), adminKycReviews table, document upload flow, Digio
   client library, admin review page, and the consent gating check in complete-step2.

  What Needs to Be Built

  The main gaps are: actual PDF generation, Aadhaar eSign integration for consent (Digio), customer-facing consent page, eSign webhook, SMS/WhatsApp provider
  integration, link expiry cron, and enhanced admin review UI.

  The plan file has the full breakdown with recommended implementation phases.

───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Ready to code?                                                                           

 Here is Claude's plan:                                                                                                                                            
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Plan: Customer Consent + Document Upload — KYC Step 2                                                                                                             
                                                        
 Context

 The BRD defines a two-part system for KYC Step 2 in lead creation:
 1. Customer Consent Workflow — Get legally valid consent before processing KYC
 2. Document Upload & Admin Verification — Two-stage document handling (dealer uploads → admin reviews)

 This builds on top of existing infrastructure — the codebase already has partial implementations for consent, document upload, and admin review.

 ---
 Part 1: CONSENT WORKFLOW — What It Does

 Two mutually exclusive paths for obtaining customer consent:

 Path A: Digital Consent (Aadhaar eSign) — Preferred

 Dealer clicks "Send SMS/WhatsApp Consent"
   → System generates consent link with token
   → SMS/WhatsApp sent to customer phone
   → Customer opens link → Reviews consent text → Signs with Aadhaar OTP
   → eSign provider (Digio/eMudhra) returns signed PDF via webhook
   → consent_status = 'admin_review_pending'
   → Admin reviews signed PDF → Approves or Rejects
   → consent_status = 'admin_verified' (FINAL — can proceed)

 State machine:
 awaiting_signature → link_sent → link_opened → esign_in_progress → esign_completed → admin_review_pending → admin_verified

 Failure/edge cases: link expiry (24hrs cron), esign failure (3 retries then blocked), admin rejection (re-consent flow)

 Path B: Manual Consent (Offline Signed PDF) — Fallback

 Dealer clicks "Generate Consent PDF"
   → System generates pre-filled PDF with consent text
   → PDF auto-downloads to dealer's device
   → Dealer prints → Customer signs physically → Dealer scans/photographs
   → Dealer uploads signed PDF
   → consent_status = 'manual_review_pending'
   → Admin reviews (checks signatures, thumb impression, witness, legibility)
   → consent_status = 'manual_verified' (FINAL — can proceed)

 State machine:
 awaiting_signature → consent_generated → consent_uploaded → admin_review_pending → admin_verified


 Critical Rule

 "Save & Next" button is ONLY enabled when consent_status IN ('admin_verified', 'manual_verified') — no lead proceeds without admin-approved consent.

 ---
 Part 2: DOCUMENT UPLOAD — What It Does

 Stage 1: Dealer Upload (dealer-facing)

 - Dealer uploads 11 documents (for finance) or 3 (for upfront)
 - Documents: Aadhaar front/back, PAN, passport photo, address proof, bank statement, 4 cheques, RC copy (conditional)
 - Simple upload only — NO OCR or API verification at this stage
 - Status visible to dealer: Not Uploaded → Uploaded - Pending Review → Verified / Reupload Required
 - Progress counter: "9/11 Uploaded, Missing: PAN Card, Passport Photo"

 Stage 2: Admin Verification (admin-facing, invisible to dealer)

 - Admin reviews uploaded documents in a queue
 - System runs OCR + API verification (Decentro)
 - Admin approves/rejects each document with reasons
 - Rejected docs trigger "Reupload Required" for dealer
 - Dealer cannot proceed to Step 3 until Admin marks ALL documents as verified

 ---
 What Already Exists vs. What's New

 Already Exists (can reuse):

 ┌────────────────────────────┬─────────────────────────────────────────────────┬──────────────────────────────────────────────────┐
 │         Component          │                    Location                     │                      Status                      │
 ├────────────────────────────┼─────────────────────────────────────────────────┼──────────────────────────────────────────────────┤
 │ consentRecords table       │ schema.ts:868-884                               │ Has token, link, status, signed_url, verified_by │
 ├────────────────────────────┼─────────────────────────────────────────────────┼──────────────────────────────────────────────────┤
 │ leads.consent_status field │ schema.ts:230                                   │ Already tracks consent state                     │
 ├────────────────────────────┼─────────────────────────────────────────────────┼──────────────────────────────────────────────────┤
 │ kycDocuments table         │ schema.ts:820-844                               │ Full doc upload tracking                         │
 ├────────────────────────────┼─────────────────────────────────────────────────┼──────────────────────────────────────────────────┤
 │ adminKycReviews table      │ schema.ts:1041-1054                             │ Review outcomes, rejection reasons               │
 ├────────────────────────────┼─────────────────────────────────────────────────┼──────────────────────────────────────────────────┤
 │ kycVerifications table     │ schema.ts:846-866                               │ API verification tracking                        │
 ├────────────────────────────┼─────────────────────────────────────────────────┼──────────────────────────────────────────────────┤
 │ Send consent API           │ api/kyc/[leadId]/send-consent/route.ts          │ Generates token + link (SMS TODO)                │
 ├────────────────────────────┼─────────────────────────────────────────────────┼──────────────────────────────────────────────────┤
 │ Generate consent PDF API   │ api/kyc/[leadId]/generate-consent-pdf/route.ts  │ Placeholder (PDF gen TODO)                       │
 ├────────────────────────────┼─────────────────────────────────────────────────┼──────────────────────────────────────────────────┤
 │ Upload signed consent API  │ api/kyc/[leadId]/upload-signed-consent/route.ts │ Stores PDF, updates status                       │
 ├────────────────────────────┼─────────────────────────────────────────────────┼──────────────────────────────────────────────────┤
 │ Document upload API        │ api/kyc/[leadId]/upload-document/route.ts       │ Full upload flow works                           │
 ├────────────────────────────┼─────────────────────────────────────────────────┼──────────────────────────────────────────────────┤
 │ Admin KYC review API       │ api/admin/kyc-reviews/route.ts                  │ GET queue + POST review                          │
 ├────────────────────────────┼─────────────────────────────────────────────────┼──────────────────────────────────────────────────┤
 │ Admin KYC review page      │ admin/kyc-review/page.tsx                       │ Lists pending docs                               │
 ├────────────────────────────┼─────────────────────────────────────────────────┼──────────────────────────────────────────────────┤
 │ Digio client/service       │ lib/digio/client.ts, service.ts, mapper.ts      │ Agreement creation, status, download             │
 ├────────────────────────────┼─────────────────────────────────────────────────┼──────────────────────────────────────────────────┤
 │ Complete step 2 API        │ api/kyc/[leadId]/complete-step2/route.ts        │ Validates consent + docs before proceeding       │
 ├────────────────────────────┼─────────────────────────────────────────────────┼──────────────────────────────────────────────────┤
 │ KYC page (Step 2 UI)       │ dealer-portal/leads/[id]/kyc/page.tsx           │ Full page with consent + doc sections            │
 ├────────────────────────────┼─────────────────────────────────────────────────┼──────────────────────────────────────────────────┤
 │ isFinalConsentStatus()     │ kyc/page.tsx:37                                 │ Already checks admin_verified/manual_verified    │
 └────────────────────────────┴─────────────────────────────────────────────────┴──────────────────────────────────────────────────┘

 Needs to Be Built:

 ┌───────────────────────────────────────┬────────────────────────────────────────────────────────────────────────────────┐
 │               Component               │                                 What's Missing                                 │
 ├───────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
 │ SMS/WhatsApp sending                  │ Actual provider integration (MSG91/Twilio/WhatsApp Business API)               │
 ├───────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
 │ Consent PDF generation                │ Real PDF template with pdfkit/Puppeteer (consent text, signature boxes)        │
 ├───────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
 │ Aadhaar eSign flow                    │ Digio eSign for consent (not agreements) — link generation, OTP page, callback │
 ├───────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
 │ eSign webhook handler                 │ POST /api/kyc/consent/esign/callback — receive signed PDF from provider        │
 ├───────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
 │ Customer consent page                 │ Public page at /consent/{leadId}/{token} — consent text + "Sign with Aadhaar"  │
 ├───────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
 │ Consent link expiry cron              │ Hourly job to expire 24hr-old links                                            │
 ├───────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
 │ Consent status state machine          │ Expand from 5 states to full 10-state machine per BRD                          │
 ├───────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
 │ Admin consent review queue            │ Dedicated queue view (currently mixed with doc review)                         │
 ├───────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
 │ Admin consent review screen           │ PDF viewer + digital signature details + approve/reject                        │
 ├───────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
 │ Re-consent flow                       │ On rejection: generate new link, notify customer, increment attempt count      │
 ├───────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
 │ Document progress counter             │ "9/11 Uploaded" UI component                                                   │
 ├───────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
 │ Dealer-simplified status mapping      │ Map internal statuses to dealer-friendly labels                                │
 ├───────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
 │ Admin document verification checklist │ Manual checks UI (legible, signatures present, etc.)                           │
 ├───────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
 │ Reupload notification                 │ When admin rejects → dealer sees "Reupload Required" with reason               │
 └───────────────────────────────────────┴────────────────────────────────────────────────────────────────────────────────┘

 ---
 Implementation Order (Recommended)

 Phase 1: Consent State Machine + DB Schema Updates

 - Expand consent_status to support full BRD state machine
 - Add missing fields to consentRecords: esign_transaction_id, esign_certificate_id, consent_attempt_count, consent_delivery_channel, consent_link_expires_at
 - Add doc_status enum to kycDocuments for dealer-facing status

 Phase 2: Manual Consent Path (simpler, no external dependency)

 - Build consent PDF template with pdfkit/Puppeteer
 - Implement download + upload + admin review flow
 - Build admin consent review screen

 Phase 3: Digital Consent Path (requires eSign provider)

 - Build customer-facing consent page (/consent/[leadId]/[token])
 - Integrate Digio eSign for consent signing
 - Build eSign webhook handler
 - Implement link expiry cron

 Phase 4: SMS/WhatsApp Integration

 - Integrate MSG91 or Twilio for consent link delivery
 - WhatsApp Business API for WhatsApp channel

 Phase 5: Admin Review Enhancements

 - Dedicated consent review queue
 - Document verification checklist UI
 - Re-consent and reupload flows

 ---
 Verification

 - Test manual consent: generate PDF → download → upload signed → admin approve → "Save & Next" enables
 - Test digital consent: send link → customer signs → webhook → admin approve → "Save & Next" enables
 - Test rejection: admin rejects → dealer notified → re-consent/reupload → admin re-reviews
 - Test gating: verify "Save & Next" is blocked unless consent_status is admin_verified/manual_verified
 - Test document upload: upload all required docs → admin verifies all → step completion allowed