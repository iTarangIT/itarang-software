#!/usr/bin/env bash
# Install OS packages required by Puppeteer's bundled Chromium on the sandbox
# VPS. Invoked from .github/workflows/deploy-sandbox.yml on every deploy and
# safe to re-run (apt-get install is idempotent).
#
# Why this exists: Hostinger's minimal Debian/Ubuntu image ships without the
# GTK/ATK/NSS libraries that headless Chromium links against, so Puppeteer's
# downloaded Chromium aborts with "libatk-1.0.so.0: cannot open shared object
# file" (exit code 127) the first time any PDF route is hit.
#
# The deploy user may not have passwordless sudo. In a non-interactive SSH
# session `sudo` cannot prompt for a password, so we detect that up front
# and skip with a warning rather than failing the whole deploy. Install the
# libs once manually as root (or add a NOPASSWD apt-get rule to sudoers) to
# get the self-healing behavior.

set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

if [ "$(id -u)" = "0" ]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1 && sudo -n apt-get --version >/dev/null 2>&1; then
  SUDO="sudo -n"
else
  echo "::warning::Skipping Chromium system-lib install — deploy user cannot run apt-get without a password."
  echo "::warning::To enable auto-install, add this sudoers rule on the VPS (visudo): deploy-user ALL=(ALL) NOPASSWD: /usr/bin/apt-get"
  echo "::warning::Or run scripts/sandbox-system-setup.sh once manually as root."
  exit 0
fi

$SUDO apt-get update -y

# Package names shifted to the t64 suffix in Ubuntu 24.04 (libc6-time64
# transition). Install the t64 variant where available, otherwise fall back
# to the legacy name so this works across Debian/Ubuntu releases.
install_pkg() {
  local pkg="$1"
  if ! $SUDO apt-get install -y "${pkg}t64" 2>/dev/null; then
    $SUDO apt-get install -y "$pkg"
  fi
}

for p in \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libnss3 libnspr4 \
  libxcomposite1 libxdamage1 libxrandr2 libgbm1 libxkbcommon0 \
  libpango-1.0-0 libpangocairo-1.0-0 libcairo2 libasound2 \
  libx11-xcb1 libxss1 libgtk-3-0 libxshmfence1 ; do
  install_pkg "$p"
done

$SUDO apt-get install -y fonts-liberation ca-certificates

echo "Chromium system deps installed"
