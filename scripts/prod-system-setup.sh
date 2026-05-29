#!/usr/bin/env bash
# Ensure Google Chrome (stable) is installed on the production VPS so the PDF /
# agreement-signing routes have a system Chromium to drive via Puppeteer.
#
# Why this exists: src/lib/pdf/launch-browser.ts prefers
# PUPPETEER_EXECUTABLE_PATH (/usr/bin/google-chrome-stable on the VPS). If Chrome
# isn't installed, every PDF route (dealer agreement "Initiate", "Download Audit
# Trail", Step 2 consent, admin "Download Profile") falls back to the bundled
# @sparticuz/chromium — whose binary dir Next.js standalone tracing drops — and
# fails with "The input directory .../@sparticuz/chromium/bin does not exist".
# Installing google-chrome-stable (which bundles its own GTK/NSS libs) makes the
# fast, reliable path always available.
#
# Invoked from .github/workflows/deploy-production.yml on every deploy. Safe to
# re-run: it fast-paths out if Chrome is already present, and apt is idempotent.
#
# The deploy user may lack passwordless sudo. In a non-interactive SSH session
# sudo cannot prompt, so we detect that up front and skip with a warning rather
# than failing the whole deploy. Install Chrome once manually as root (or add a
# NOPASSWD apt-get sudoers rule) to get the self-healing behaviour.

set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

CHROME_BIN=/usr/bin/google-chrome-stable

# Fast path: Chrome already installed — nothing to do. This is the common case
# on every redeploy and avoids touching apt entirely.
if [ -x "$CHROME_BIN" ]; then
  echo "Google Chrome already installed at $CHROME_BIN — skipping apt"
  "$CHROME_BIN" --version || true
  exit 0
fi

if [ "$(id -u)" = "0" ]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1 && sudo -n apt-get --version >/dev/null 2>&1; then
  SUDO="sudo -n"
else
  echo "::warning::Skipping Google Chrome install — deploy user cannot run apt-get without a password."
  echo "::warning::Install once manually as root:  bash scripts/prod-system-setup.sh"
  echo "::warning::Or add a sudoers rule (visudo):  deploy-user ALL=(ALL) NOPASSWD: /usr/bin/apt-get"
  exit 0
fi

echo "Google Chrome not found — installing google-chrome-stable"

$SUDO apt-get update -y
$SUDO apt-get install -y ca-certificates curl gnupg

# Add Google's signing key + apt repo (idempotent — re-running overwrites the
# same files). Use the keyring path referenced by the repo's signed-by clause.
$SUDO install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
  | $SUDO gpg --batch --yes --dearmor -o /etc/apt/keyrings/google-chrome.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
  | $SUDO tee /etc/apt/sources.list.d/google-chrome.list >/dev/null

$SUDO apt-get update -y
$SUDO apt-get install -y google-chrome-stable

if [ ! -x "$CHROME_BIN" ]; then
  echo "❌ Google Chrome install reported success but $CHROME_BIN is missing"
  exit 1
fi

echo "✅ Google Chrome installed"
"$CHROME_BIN" --version || true
