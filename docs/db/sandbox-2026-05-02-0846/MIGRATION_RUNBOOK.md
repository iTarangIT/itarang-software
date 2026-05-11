# Sandbox → Production Migration Runbook

**Snapshot:** sandbox `database-1` introspected 2026-05-02 ~08:46 IST.
**Inventory:** [`sandbox-catalog.xlsx`](./sandbox-catalog.xlsx) — 129 tables, 14 preserve, 115 truncate, 55,689 rows total.
**Goal:** bring production `database-2` to schema parity with sandbox; preserve prod's existing rows for the 14 preserve-list tables; truncate every other table in prod and leave it empty.

| | Endpoint |
|--|--|
| Sandbox (database-1) | `database-1.c9w88wq6qyco.ap-south-1.rds.amazonaws.com:5432/postgres` |
| Production (database-2) | `database-2.c9w88wq6qyco.ap-south-1.rds.amazonaws.com:5432/postgres` |

Region: `ap-south-1`.

## Preserve list (14 tables — data stays in prod)

`users`, `accounts`, `product_categories`, `products`,
plus every table starting with `scraper_` or `scraped_`:
`scraper_runs`, `scraper_run_chunks`, `scraper_leads`, `scraper_leads_duplicates`,
`scraper_raw`, `scraper_city_queue`, `scraper_schedules`, `scraper_search_queries`,
`scraper_dedup_logs`, `scraped_dealer_leads`.

Single source of truth: `PRESERVE_TABLES` + `PRESERVE_PREFIXES` in
`scripts/db-sandbox-excel.ts`. The Phase-4 truncate query below uses the same
predicate.

## Prerequisites

```bash
# Tools
psql --version          # PostgreSQL 14+ client
pg_dump --version       # same major version as RDS server
aws --version           # AWS CLI v2

# Credentials
export AWS_PROFILE=itarang        # has rds:CreateDBSnapshot, rds:DescribeDBSnapshots
export SANDBOX_URL='postgresql://postgres:...@database-1...:5432/postgres?sslmode=require'
export PROD_URL='postgresql://postgres:...@database-2...:5432/postgres?sslmode=require'

# Working dir
mkdir -p ~/itarang-migration-2026-05-02 && cd ~/itarang-migration-2026-05-02
```

## Phase 0 — Pre-flight (read-only, ~2 min)

```bash
# Sanity: confirm we're hitting the right DBs
psql "$SANDBOX_URL" -c "SELECT current_database(), inet_server_addr();"
psql "$PROD_URL"    -c "SELECT current_database(), inet_server_addr();"

# Per-table row counts (commit these to the audit folder)
COUNT_QUERY="
  SELECT table_name,
         (xpath('/row/c/text()',
           query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
                        false, true, '')))[1]::text::bigint AS rows
  FROM information_schema.tables
  WHERE table_schema='public' AND table_type='BASE TABLE'
  ORDER BY table_name;"

psql "$SANDBOX_URL" -At -F $'\t' -c "$COUNT_QUERY" > sandbox_counts_before.tsv
psql "$PROD_URL"    -At -F $'\t' -c "$COUNT_QUERY" > prod_counts_before.tsv
```

## Phase 1 — Production safety snapshot via AWS CLI (~5–15 min)

This is your single rollback point. Do not skip.

```bash
SNAP_ID="prod-pre-migration-$(date -u +%Y%m%d-%H%M)"
echo "Snapshot id: $SNAP_ID"

aws rds create-db-snapshot \
  --region ap-south-1 \
  --db-instance-identifier database-2 \
  --db-snapshot-identifier "$SNAP_ID"

aws rds wait db-snapshot-available \
  --region ap-south-1 \
  --db-snapshot-identifier "$SNAP_ID"

aws rds describe-db-snapshots \
  --region ap-south-1 \
  --db-snapshot-identifier "$SNAP_ID" \
  --query 'DBSnapshots[0].[Status,SnapshotCreateTime,AllocatedStorage,DBInstanceIdentifier]' \
  --output table
```

**Rollback (only if a later phase goes wrong):**

```bash
# Restores to a NEW instance — do not just delete database-2.
aws rds restore-db-instance-from-db-snapshot \
  --region ap-south-1 \
  --db-instance-identifier database-2-restored \
  --db-snapshot-identifier "$SNAP_ID"

# After restore is available: update DATABASE_URL in .env.production and Vercel
# to point at database-2-restored, then schedule decommission of the broken instance.
```

## Phase 2 — Dump sandbox schema only (~2 min)

```bash
pg_dump "$SANDBOX_URL" \
  --schema-only \
  --no-owner --no-privileges \
  --schema=public \
  --file=sandbox_schema.sql

# Sanity: should be ~10–30k lines, all DDL, zero COPY blocks
wc -l sandbox_schema.sql
grep -c '^COPY ' sandbox_schema.sql   # must be 0
```

`--schema-only` ⇒ no row data. `--no-owner --no-privileges` keeps the dump
RDS-friendly (RDS rejects ROLE / GRANT statements that target the cluster owner).

## Phase 3 — Apply schema to production (~5 min)

We do **not** drop the prod public schema (that would wipe the preserve-list
data). We apply the sandbox DDL idempotently and tolerate "already exists" /
"duplicate column" errors, then run a column-level diff to catch any drift.

```bash
# 3a — apply DDL; tolerate already-exists errors
PGOPTIONS='--client-min-messages=warning' \
  psql "$PROD_URL" -v ON_ERROR_STOP=0 -f sandbox_schema.sql 2> apply_schema.err

# Inspect the error file. Expected: lots of "already exists" / "duplicate".
# Anything else (syntax errors, missing extension, missing role) -> stop.
grep -v -E 'already exists|duplicate' apply_schema.err | head -50

# 3b — column-level reconciliation against prod
cd /Users/apoorvgupta/Desktop/Itarang\ Files/itarang\ code/test_main
DATABASE_URL="$PROD_URL" npx tsx scripts/db-drift.ts > post-schema-diff.txt 2>&1
cat post-schema-diff.txt

# Expected: zero drift after this step. If drift remains, write a targeted
# ALTER script under drizzle/ following the pattern of
# drizzle/0034_full_sandbox_to_prod_sync.sql, apply it, and re-diff.
cd -
```

## Phase 4 — Truncate non-preserved tables in production (destructive)

Generate the truncate set dynamically from prod so we never miss a table.

```bash
psql "$PROD_URL" -At -c "
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema='public'
    AND table_type='BASE TABLE'
    AND table_name NOT IN ('users','accounts','product_categories','products')
    AND table_name NOT LIKE 'scraper\_%'
    AND table_name NOT LIKE 'scraped\_%'
  ORDER BY table_name;" > tables_to_truncate.tsv

wc -l tables_to_truncate.tsv     # expect ~115
head tables_to_truncate.tsv

# Verify the preserve-list tables are NOT in the truncate set
grep -E '^(users|accounts|product_categories|products|scraper_|scraped_)' tables_to_truncate.tsv
# ^ must print nothing
```

Verify the preserve-list tables don't have FKs pointing INTO any truncated table
(if they did, CASCADE would propagate into the preserve list):

```bash
psql "$PROD_URL" -At -F $'\t' -c "
  SELECT cl.relname AS preserved_table, ref.relname AS references_table
  FROM pg_constraint c
  JOIN pg_class cl  ON cl.oid = c.conrelid
  JOIN pg_class ref ON ref.oid = c.confrelid
  JOIN pg_namespace n ON n.oid = cl.relnamespace
  WHERE c.contype='f' AND n.nspname='public'
    AND (cl.relname IN ('users','accounts','product_categories','products')
         OR cl.relname LIKE 'scraper\_%'
         OR cl.relname LIKE 'scraped\_%')
  ORDER BY cl.relname;"
# If any row's references_table is in tables_to_truncate.tsv -> STOP.
# Manually drop that FK or invert the order before continuing.
```

Build the truncate SQL and apply:

```bash
{
  echo "BEGIN;"
  echo "SET LOCAL statement_timeout = '10min';"
  awk 'BEGIN{printf "TRUNCATE TABLE "} {printf (NR==1?"":", ") "public." $1} END{print " RESTART IDENTITY CASCADE;"}' \
    tables_to_truncate.tsv
  echo "COMMIT;"
} > truncate_prod.sql

# Final review
less truncate_prod.sql

# Apply (this is the destructive step)
psql "$PROD_URL" -v ON_ERROR_STOP=1 -f truncate_prod.sql
```

## Phase 5 — Post-flight verification

```bash
# Counts after
psql "$PROD_URL" -At -F $'\t' -c "$COUNT_QUERY" > prod_counts_after.tsv

# Every non-preserved table must be 0
awk -F'\t' '
  $1 ~ /^(users|accounts|product_categories|products)$/ ||
  $1 ~ /^scraper_/ || $1 ~ /^scraped_/ { next }
  $2 != "0" { print "NON-ZERO:", $0; bad=1 }
  END { exit bad ? 1 : 0 }
' prod_counts_after.tsv && echo "OK: all non-preserved tables are empty"

# Every preserved table must be >= its before count
join -t $'\t' \
  <(sort prod_counts_before.tsv) \
  <(sort prod_counts_after.tsv) \
| awk -F'\t' '
  $1 ~ /^(users|accounts|product_categories|products)$/ ||
  $1 ~ /^scraper_/ || $1 ~ /^scraped_/ {
    if ($3+0 < $2+0) { print "SHRUNK:", $0; bad=1 }
  }
  END { exit bad ? 1 : 0 }
' && echo "OK: preserved tables intact"

# Schema parity
DATABASE_URL="$PROD_URL" npx tsx scripts/db-drift.ts | tee post-migration-diff.txt

# App smoke test (run from repo root)
DATABASE_URL="$PROD_URL" npm run build
DATABASE_URL="$PROD_URL" npm run start &
sleep 10 && curl -fsS http://localhost:3000/api/health
```

## Audit artifacts to commit

After the migration, commit the following into this directory:

- `sandbox_counts_before.tsv`, `prod_counts_before.tsv`, `prod_counts_after.tsv`
- `apply_schema.err`
- `post-schema-diff.txt`, `post-migration-diff.txt`
- `tables_to_truncate.tsv`, `truncate_prod.sql`
- `aws-snapshot-id.txt` (just the snapshot id)

These give an auditable trail: what the DBs looked like before, what changed,
and what they looked like after.

## Estimated wall time

| Phase | Duration |
|---|---|
| 0 — Pre-flight | ~2 min |
| 1 — RDS snapshot | 5–15 min (mostly waiting) |
| 2 — pg_dump schema | ~2 min |
| 3 — Apply schema | ~5 min |
| 4 — Truncate prod | ~2 min |
| 5 — Verify | ~10 min |
| **Total** | **~30–60 min** |

## Driver script

`scripts/migrate-sandbox-to-prod.sh` wraps phases 0–5 with explicit `yes`
prompts before any destructive op. It expects `SANDBOX_URL`, `PROD_URL`, and
`AWS_PROFILE` in the environment.
