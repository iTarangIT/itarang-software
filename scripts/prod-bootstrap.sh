#!/usr/bin/env bash
# scripts/prod-bootstrap.sh
#
# One-time prep for the PRODUCTION VPS before the runner-build deploy workflow
# (`.github/workflows/deploy-production.yml`) ships its first release.
#
# Run this on the VPS as the deploy user (NEVER as root), once:
#
#   ssh <prod-deploy-user>@<PROD_VPS_HOST> -p <PROD_VPS_PORT> \
#     'cd /home/itarang-crm/htdocs/crm.itarang.com && bash scripts/prod-bootstrap.sh'
#
# Safe to re-run; every step is idempotent. The workflow itself performs the same
# prep on every deploy (Stage B "Bootstrap release layout + write shared/.env"), so
# running this is optional — it just keeps the FIRST deploy log small and lets you
# stage shared/.env ahead of time.
#
# Unlike the sandbox box, production has NO pm2 worker, so there is no worker
# `npm ci` / node_modules step here — the shipped standalone bundle carries its own
# node_modules.

set -eo pipefail

APP_DIR=${APP_DIR:-/home/itarang-crm/htdocs/crm.itarang.com}

cd "$APP_DIR"

echo ">>> Creating release layout under $APP_DIR"
mkdir -p releases shared/logs

echo ">>> Seeding shared/.env (canonical runtime env home)"
if [ ! -f shared/.env ]; then
  # The old build-on-box workflow wrote .env.production into the repo root.
  # Migrate it if present; otherwise the first deploy writes shared/.env from the
  # PROD_ENV_FILE_B64 secret.
  if [ -f .env.production ]; then
    cp .env.production shared/.env
    chmod 600 shared/.env
    echo "Copied .env.production -> shared/.env"
  elif [ -f .env ]; then
    cp .env shared/.env
    chmod 600 shared/.env
    echo "Copied .env -> shared/.env"
  else
    echo "⚠ No .env(.production) found at repo root. The first deploy will write"
    echo "  shared/.env from the PROD_ENV_FILE_B64 secret."
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

echo ">>> Bootstrap complete. Layout:"
ls -la "$APP_DIR" | head -20
echo ""
echo "Next: merge to main. The first deploy will create releases/<sha>/standalone/,"
echo "swap the 'current' symlink, and (re)start pm2 onto 'node current/server.js'."
echo "The old repo-root .next/ and /home/itarang-crm/static_archive become orphaned"
echo "and can be removed manually after a green deploy to reclaim disk."
