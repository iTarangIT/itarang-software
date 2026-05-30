#!/usr/bin/env bash
# Provision the OS prerequisites for headless-Chromium PDF rendering on the
# iTarang VPS. Shared by BOTH environments:
#   - sandbox: shipped to the box by .github/workflows/deploy-sandbox.yml (the
#     sandbox box never runs `git pull`, so the workflow SCPs this file in and
#     then runs it — same pattern as ecosystem.sandbox.config.js).
#   - production: invoked from .github/workflows/deploy-production.yml after the
#     `git reset --hard`, so the box already has the current copy.
#
# It installs TWO things, both idempotently:
#   1. The GTK/ATK/NSS shared libraries headless Chromium links against
#      (without them Chromium aborts with "libatk-1.0.so.0: cannot open shared
#      object file", exit 127).
#   2. Google Chrome itself (google-chrome-stable) — the actual browser binary
#      that PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable points at.
#      Previously only the libs were installed and the binary was *assumed*
#      present; nothing in the pipeline ever installed it. That is why
#      "Failed to launch the browser process ... ENOENT" kept coming back
#      after every redeploy / box reset: the binary only ever existed when
#      someone installed it by hand, out of band, and the next deploy reset it.
#
# Ends with a launch preflight so a missing/broken browser fails the DEPLOY
# loudly instead of surfacing as an ENOENT the first time a user clicks a PDF
# button (Initiate Agreement, KYC consent, lead profile, audit trail).
#
# The deploy user may not have passwordless sudo. We detect that and skip the
# apt install with a warning, but STILL run the preflight — so the deploy fails
# loudly with an actionable message rather than silently shipping a broken
# browser. To get full self-healing, add a sudoers NOPASSWD rule for apt-get
# (see the warning text below) or install google-chrome-stable once as root.

set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# The path the app launches at runtime (ecosystem.*.config.js pins this too).
CHROME_BIN="${PUPPETEER_EXECUTABLE_PATH:-/usr/bin/google-chrome-stable}"

# ── Resolve apt privileges (do NOT early-exit; the preflight must still run) ─
SUDO=""
CAN_APT=1
if [ "$(id -u)" = "0" ]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1 && sudo -n apt-get --version >/dev/null 2>&1; then
  SUDO="sudo -n"
else
  CAN_APT=0
  echo "::warning::Cannot run apt-get without a password — skipping install, relying on preflight."
  echo "::warning::To enable auto-install, add a sudoers NOPASSWD rule (visudo): deploy-user ALL=(ALL) NOPASSWD: /usr/bin/apt-get"
  echo "::warning::Or install google-chrome-stable + the Chromium libs once manually as root."
fi

pkg_installed() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q '^install ok installed$'
}

# ── 1. Shared libraries headless Chromium links against ─────────────────────
PKGS_BASE="
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libnss3 libnspr4
  libxcomposite1 libxdamage1 libxrandr2 libgbm1 libxkbcommon0
  libpango-1.0-0 libpangocairo-1.0-0 libcairo2 libasound2
  libx11-xcb1 libxss1 libgtk-3-0 libxshmfence1
"
# wget + gnupg are needed to add Google's apt repo for the Chrome install below.
PKGS_EXTRA="fonts-liberation ca-certificates wget gnupg"

libs_present=1
for p in $PKGS_BASE; do
  # Package names gained a t64 suffix in Ubuntu 24.04 (libc6-time64 transition);
  # accept either variant.
  if ! pkg_installed "${p}t64" && ! pkg_installed "$p"; then libs_present=0; fi
done
for p in $PKGS_EXTRA; do
  if ! pkg_installed "$p"; then libs_present=0; fi
done

install_pkg() {
  local pkg="$1"
  if ! $SUDO apt-get install -y "${pkg}t64" 2>/dev/null; then
    $SUDO apt-get install -y "$pkg"
  fi
}

# ── 2. The Google Chrome binary itself ──────────────────────────────────────
chrome_present=0
if command -v google-chrome-stable >/dev/null 2>&1 || [ -x "$CHROME_BIN" ]; then
  chrome_present=1
fi

if [ "$libs_present" = "1" ] && [ "$chrome_present" = "1" ]; then
  echo "Chromium libs + google-chrome-stable already present — skipping apt"
elif [ "$CAN_APT" = "0" ]; then
  echo "::warning::Provisioning incomplete (libs_present=$libs_present chrome_present=$chrome_present) and cannot apt — deferring to preflight."
else
  $SUDO apt-get update -y

  if [ "$libs_present" != "1" ]; then
    echo "Installing Chromium shared libraries…"
    for p in $PKGS_BASE; do install_pkg "$p"; done
    $SUDO apt-get install -y $PKGS_EXTRA
  fi

  if [ "$chrome_present" != "1" ]; then
    echo "Installing google-chrome-stable from Google's apt repository…"
    $SUDO install -m 0755 -d /etc/apt/keyrings
    wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
      | $SUDO gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
    $SUDO chmod a+r /etc/apt/keyrings/google-chrome.gpg
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      | $SUDO tee /etc/apt/sources.list.d/google-chrome.list >/dev/null
    $SUDO apt-get update -y
    $SUDO apt-get install -y google-chrome-stable
  fi
fi

# ── 3. Fail-loud preflight ──────────────────────────────────────────────────
# `--version` is enough to prove the binary exists and is executable, which is
# exactly the ENOENT failure mode we are guarding against. A missing binary or
# a bad PUPPETEER_EXECUTABLE_PATH fails here and stops the deploy.
echo "Preflight: $CHROME_BIN --version"
if ! "$CHROME_BIN" --version; then
  echo "❌ Chromium preflight FAILED: '$CHROME_BIN' is missing or not executable."
  echo "   PDF rendering (Initiate Agreement, KYC consent, audit trail) would throw"
  echo "   'Failed to launch the browser process ... ENOENT' for every user."
  echo "   Fix: ensure google-chrome-stable is installed at $CHROME_BIN — re-run this"
  echo "   script as root, or add a NOPASSWD apt-get sudoers rule so the deploy can"
  echo "   self-heal."
  exit 1
fi
echo "✅ Chromium preflight OK: $("$CHROME_BIN" --version 2>/dev/null || echo unknown)"
