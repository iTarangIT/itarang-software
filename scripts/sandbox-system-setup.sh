#!/usr/bin/env bash
# Install OS packages required by Puppeteer's bundled Chromium on the sandbox
# VPS. Invoked from .github/workflows/deploy-sandbox.yml on every deploy and
# safe to re-run (apt-get install is idempotent).
#
# Why this exists: Hostinger's minimal Debian/Ubuntu image ships without the
# GTK/ATK/NSS libraries that headless Chromium links against, so Puppeteer's
# downloaded Chromium aborts with "libatk-1.0.so.0: cannot open shared object
# file" (exit code 127) the first time any PDF route is hit.

set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -y

# Package names shifted to the t64 suffix in Ubuntu 24.04 (libc6-time64
# transition). Install the t64 variant where available, otherwise fall back
# to the legacy name so this works across Debian/Ubuntu releases.
install_pkg() {
  local pkg="$1"
  if ! sudo apt-get install -y "${pkg}t64" 2>/dev/null; then
    sudo apt-get install -y "$pkg"
  fi
}

for p in \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libnss3 libnspr4 \
  libxcomposite1 libxdamage1 libxrandr2 libgbm1 libxkbcommon0 \
  libpango-1.0-0 libpangocairo-1.0-0 libcairo2 libasound2 \
  libx11-xcb1 libxss1 libgtk-3-0 libxshmfence1 ; do
  install_pkg "$p"
done

sudo apt-get install -y fonts-liberation ca-certificates

echo "Chromium system deps installed"
