#!/usr/bin/env bash
#
# Sandbox -> Production migration driver.
# Mirrors docs/db/sandbox-2026-05-02-0846/MIGRATION_RUNBOOK.md.
# Each destructive step waits for the operator to type "yes".
#
# Required env: SANDBOX_URL, PROD_URL, AWS_PROFILE
# Strictly read-only on sandbox. Destructive on prod (with confirmations).

set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"
PROD_INSTANCE="${PROD_DB_INSTANCE:-database-2}"
WORKDIR="${WORKDIR:-$HOME/itarang-migration-$(date -u +%Y%m%d)}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PRESERVE_TABLES_LITERAL="'users','accounts','product_categories','products'"

require_env() {
  local missing=0
  for v in SANDBOX_URL PROD_URL AWS_PROFILE; do
    if [[ -z "${!v:-}" ]]; then
      echo "ERROR: $v is not set." >&2
      missing=1
    fi
  done
  [[ $missing -eq 0 ]] || exit 1
}

confirm() {
  local prompt="$1"
  echo
  read -r -p "$prompt  Type 'yes' to continue: " ans
  if [[ "$ans" != "yes" ]]; then
    echo "Aborted." >&2
    exit 1
  fi
}

count_query() {
  cat <<'SQL'
SELECT table_name,
       (xpath('/row/c/text()',
         query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
                      false, true, '')))[1]::text::bigint AS rows
FROM information_schema.tables
WHERE table_schema='public' AND table_type='BASE TABLE'
ORDER BY table_name;
SQL
}

phase0_preflight() {
  echo "=== Phase 0: Pre-flight ==="
  psql "$SANDBOX_URL" -c "SELECT current_database(), inet_server_addr() AS sandbox;"
  psql "$PROD_URL"    -c "SELECT current_database(), inet_server_addr() AS production;"

  local q
  q="$(count_query)"
  psql "$SANDBOX_URL" -At -F $'\t' -c "$q" > sandbox_counts_before.tsv
  psql "$PROD_URL"    -At -F $'\t' -c "$q" > prod_counts_before.tsv

  echo "Sandbox tables: $(wc -l < sandbox_counts_before.tsv)"
  echo "Prod tables:    $(wc -l < prod_counts_before.tsv)"
}

phase1_snapshot() {
  echo
  echo "=== Phase 1: AWS RDS snapshot of $PROD_INSTANCE ==="
  local snap_id
  snap_id="prod-pre-migration-$(date -u +%Y%m%d-%H%M)"
  echo "Snapshot id: $snap_id"
  confirm "Create RDS snapshot of $PROD_INSTANCE in $REGION?"

  aws rds create-db-snapshot \
    --region "$REGION" \
    --db-instance-identifier "$PROD_INSTANCE" \
    --db-snapshot-identifier "$snap_id"

  echo "Waiting for snapshot to become available (this can take 5-15 min)…"
  aws rds wait db-snapshot-available \
    --region "$REGION" \
    --db-snapshot-identifier "$snap_id"

  aws rds describe-db-snapshots \
    --region "$REGION" \
    --db-snapshot-identifier "$snap_id" \
    --query 'DBSnapshots[0].[Status,SnapshotCreateTime,AllocatedStorage,DBInstanceIdentifier]' \
    --output table

  echo "$snap_id" > aws-snapshot-id.txt
}

phase2_dump() {
  echo
  echo "=== Phase 2: Dump sandbox schema (no data) ==="
  pg_dump "$SANDBOX_URL" \
    --schema-only \
    --no-owner --no-privileges \
    --schema=public \
    --file=sandbox_schema.sql

  local lines copies
  lines=$(wc -l < sandbox_schema.sql)
  copies=$(grep -c '^COPY ' sandbox_schema.sql || true)
  echo "Lines: $lines    COPY blocks: $copies (must be 0)"
  if [[ "$copies" != "0" ]]; then
    echo "ERROR: pg_dump emitted COPY blocks. Aborting." >&2
    exit 1
  fi
}

phase3_apply_schema() {
  echo
  echo "=== Phase 3: Apply sandbox DDL to production ==="
  confirm "Apply $(wc -l < sandbox_schema.sql) lines of DDL to PROD?"
  PGOPTIONS='--client-min-messages=warning' \
    psql "$PROD_URL" -v ON_ERROR_STOP=0 -f sandbox_schema.sql 2> apply_schema.err || true

  echo "--- Unexpected DDL errors (filtering out 'already exists' / 'duplicate') ---"
  grep -v -E 'already exists|duplicate' apply_schema.err | head -50 || true
  echo "--- end ---"

  echo "Running schema drift check against prod…"
  ( cd "$REPO_ROOT" && DATABASE_URL="$PROD_URL" npx tsx scripts/db-drift.ts ) \
    | tee post-schema-diff.txt
}

phase4_truncate() {
  echo
  echo "=== Phase 4: Truncate non-preserved tables in PROD ==="

  psql "$PROD_URL" -At -c "
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema='public'
      AND table_type='BASE TABLE'
      AND table_name NOT IN ($PRESERVE_TABLES_LITERAL)
      AND table_name NOT LIKE 'scraper\\_%'
      AND table_name NOT LIKE 'scraped\\_%'
    ORDER BY table_name;" > tables_to_truncate.tsv

  echo "Tables to TRUNCATE: $(wc -l < tables_to_truncate.tsv)"
  echo "Preserve-list leakage check (must be empty):"
  grep -E '^(users|accounts|product_categories|products|scraper_|scraped_)' tables_to_truncate.tsv \
    && { echo "ERROR: preserve-list table appears in truncate set" >&2; exit 1; } \
    || echo "  ok"

  echo "Preserve-list FK leakage check (must be empty):"
  psql "$PROD_URL" -At -F $'\t' -c "
    SELECT cl.relname AS preserved_table, ref.relname AS references_table
    FROM pg_constraint c
    JOIN pg_class cl  ON cl.oid = c.conrelid
    JOIN pg_class ref ON ref.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE c.contype='f' AND n.nspname='public'
      AND (cl.relname IN ($PRESERVE_TABLES_LITERAL)
           OR cl.relname LIKE 'scraper\\_%'
           OR cl.relname LIKE 'scraped\\_%')
    ORDER BY cl.relname;" | tee preserved_fks.tsv
  if [[ -s preserved_fks.tsv ]]; then
    echo
    echo "WARN: preserved tables have FKs. Cross-check that none of the references_table"
    echo "      values appear in tables_to_truncate.tsv before continuing."
  fi

  {
    echo "BEGIN;"
    echo "SET LOCAL statement_timeout = '10min';"
    awk 'BEGIN{printf "TRUNCATE TABLE "} {printf (NR==1?"":", ") "public." $1} END{print " RESTART IDENTITY CASCADE;"}' \
      tables_to_truncate.tsv
    echo "COMMIT;"
  } > truncate_prod.sql

  echo "----- truncate_prod.sql -----"
  head -c 2000 truncate_prod.sql; echo "…"
  echo "----- end -----"

  confirm "Apply truncate_prod.sql to PROD? This wipes ~$(wc -l < tables_to_truncate.tsv) tables."
  psql "$PROD_URL" -v ON_ERROR_STOP=1 -f truncate_prod.sql
}

phase5_verify() {
  echo
  echo "=== Phase 5: Post-flight verification ==="
  local q
  q="$(count_query)"
  psql "$PROD_URL" -At -F $'\t' -c "$q" > prod_counts_after.tsv

  awk -F'\t' '
    $1 ~ /^(users|accounts|product_categories|products)$/ ||
    $1 ~ /^scraper_/ || $1 ~ /^scraped_/ { next }
    $2 != "0" { print "NON-ZERO:", $0; bad=1 }
    END { exit bad ? 1 : 0 }
  ' prod_counts_after.tsv && echo "OK: all non-preserved tables are empty"

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

  ( cd "$REPO_ROOT" && DATABASE_URL="$PROD_URL" npx tsx scripts/db-drift.ts ) \
    | tee post-migration-diff.txt
}

main() {
  require_env
  mkdir -p "$WORKDIR"
  cd "$WORKDIR"
  echo "Working dir: $WORKDIR"

  phase0_preflight
  phase1_snapshot
  phase2_dump
  phase3_apply_schema
  phase4_truncate
  phase5_verify

  echo
  echo "Migration complete. Artifacts in $WORKDIR:"
  ls -la "$WORKDIR"
}

main "$@"
