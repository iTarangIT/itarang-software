#!/usr/bin/env bash
# scripts/sandbox-bootstrap.sh
#
# One-time prep for the sandbox VPS BEFORE the new runner-build deploy
# workflow (`.github/workflows/deploy-sandbox.yml`) ships its first
# release.
#
# Run this on the VPS as the deploy user, once:
#
#   ssh sandbox 'cd /home/itarang-sandbox/htdocs/sandbox.itarang.com && bash scripts/sandbox-bootstrap.sh'
#
# Safe to re-run; every step is idempotent. The workflow itself also
# performs the same checks on every deploy as a belt-and-braces
# safeguard, so forgetting to run this script just means the FIRST
# deploy under the new workflow does the prep too — at the cost of a
# slightly larger first deploy log.

set -eo pipefail

APP_DIR=${APP_DIR:-/home/itarang-sandbox/htdocs/sandbox.itarang.com}

cd "$APP_DIR"

echo ">>> Creating release layout under $APP_DIR"
mkdir -p releases shared/logs

echo ">>> Migrating .env into shared/ (canonical home)"
if [ ! -f shared/.env ]; then
  if [ -f .env ]; then
    cp .env shared/.env
    chmod 600 shared/.env
    echo "Copied .env -> shared/.env"
  else
    echo "⚠ No .env found at repo root. Create shared/.env manually before the next deploy."
  fi
else
  echo "shared/.env already exists — keeping it"
fi

echo ">>> Converting logs/ to a symlink so pm2 paths survive across releases"
if [ -L logs ]; then
  echo "logs/ is already a symlink -> $(readlink logs)"
elif [ -d logs ]; then
  mv logs/* shared/logs/ 2>/dev/null || true
  rmdir logs 2>/dev/null || true
  ln -sfn shared/logs logs
  echo "Converted logs/ to symlink"
else
  ln -sfn shared/logs logs
  echo "Created logs symlink"
fi

echo ">>> Verifying worker node_modules"
if [ ! -d node_modules ]; then
  echo "node_modules missing — running npm ci (this may take a few minutes)"
  npm ci --no-audit --no-fund --include=dev
else
  echo "node_modules present — leaving as-is"
fi

echo ">>> Recording current package-lock hash"
sha256sum package-lock.json | cut -d' ' -f1 > shared/.last-lock-hash
echo "shared/.last-lock-hash = $(cat shared/.last-lock-hash)"

echo ">>> Bootstrap complete. Layout:"
ls -la "$APP_DIR" | head -20
echo ""
echo "Next: merge the runner-build PR. The first deploy will create"
echo "releases/<sha>/standalone/, swap the 'current' symlink, and reload"
echo "pm2. The old .next/ directory at repo root will become orphaned"
echo "and can be removed manually after a green deploy."
