#!/usr/bin/env bash
#
# ops-agent installer — run ON the box, from the agent's own directory.
#
#   ./install.sh                 # config from the environment or shared/.env
#   ./install.sh --dry-run       # validate + smoke-test, do not touch pm2
#
# Idempotent: safe to re-run. An existing ops-agent process is restarted with
# the new configuration rather than duplicated.
#
# WHY THIS EXISTS. The install was four manual steps in README.md, run by hand
# on each box, and three of them fail quietly:
#   · a wrong OPS_HOST_NAME is a 403 the operator never sees;
#   · a missing OPS_LOG_DIR means metrics flow and logs silently do not;
#   · forgetting `pm2 save` means the agent is gone after the next reboot, which
#     nobody notices until they need the logs.
# This validates all three BEFORE daemonising, and refuses to start an agent
# that would not work.

set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

say()  { printf '  %s\n' "$*"; }
head_() { printf '\n== %s\n' "$*"; }
die()  { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
head_ "1. Configuration"

# Pull from the box's shared/.env when the caller has not exported them. Only
# the OPS_* keys, so this cannot drag DATABASE_URL into the agent's environment.
for CANDIDATE in "${OPS_ENV_FILE:-}" ../shared/.env ../../shared/.env; do
  [ -n "$CANDIDATE" ] && [ -f "$CANDIDATE" ] || continue
  say "reading OPS_* from $CANDIDATE"
  while IFS= read -r line; do
    case "$line" in
      OPS_*=*) export "${line?}" ;;
    esac
  done < <(tr -d '\r' < "$CANDIDATE")
  break
done

: "${OPS_INGEST_URL:=}"
: "${OPS_INGEST_SECRET:=}"
: "${OPS_HOST_NAME:=}"
: "${OPS_LOG_DIR:=}"
: "${OPS_CERT_DOMAIN:=}"
: "${OPS_INTERVAL_MS:=300000}"

MISSING=""
[ -n "$OPS_INGEST_URL" ]    || MISSING="$MISSING OPS_INGEST_URL"
[ -n "$OPS_INGEST_SECRET" ] || MISSING="$MISSING OPS_INGEST_SECRET"
[ -n "$OPS_HOST_NAME" ]     || MISSING="$MISSING OPS_HOST_NAME"
[ -z "$MISSING" ] || die "missing required config:$MISSING
  Export them, or put them in the box's shared/.env, then re-run.
  OPS_HOST_NAME must be one of the names in the CRM's OPS_INGEST_HOSTS."

say "host   : $OPS_HOST_NAME"
say "ingest : $OPS_INGEST_URL"
say "secret : set (${#OPS_INGEST_SECRET} chars)"

# ---------------------------------------------------------------------------
head_ "2. Where are the CRM's logs?"

if [ -z "$OPS_LOG_DIR" ]; then
  # The agent runs with cwd = its own directory, so a relative default cannot
  # find the CRM. Look for the real thing before giving up.
  for GUESS in ../shared/logs ../../shared/logs ../current/logs ../logs; do
    if [ -f "$GUESS/web.out.log" ] || [ -f "$GUESS/web.err.log" ]; then
      OPS_LOG_DIR="$(cd "$GUESS" && pwd)"
      say "auto-detected: $OPS_LOG_DIR"
      break
    fi
  done
fi

if [ -z "$OPS_LOG_DIR" ]; then
  say "OPS_LOG_DIR is NOT set and could not be auto-detected."
  say "Only nginx will be tailed — the CRM's own errors will NOT reach"
  say "/operations/logs. Set OPS_LOG_DIR to the directory holding web.out.log."
  say "Continuing, because host metrics are still worth having."
else
  export OPS_LOG_DIR
  say "OPS_LOG_DIR = $OPS_LOG_DIR"
  [ -d "$OPS_LOG_DIR" ] || die "OPS_LOG_DIR does not exist: $OPS_LOG_DIR"
fi

# ---------------------------------------------------------------------------
head_ "3. Prerequisites"

command -v node >/dev/null 2>&1 || die "node is not on PATH"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node 18+ required (found $(node -v)); the agent uses global fetch"
say "node $(node -v)"

if command -v pm2 >/dev/null 2>&1; then
  say "pm2 $(pm2 -v 2>/dev/null | tail -1)"
  HAVE_PM2=1
else
  say "pm2 NOT found — will smoke-test only; see README for the cron alternative"
  HAVE_PM2=0
fi

# ---------------------------------------------------------------------------
head_ "4. Smoke test (one real cycle)"

# The agent prints its log-file report at startup, so this is where a bad
# OPS_LOG_DIR or an unreadable nginx file becomes visible.
set +e
OUTPUT="$(OPS_ONCE=1 node agent.js 2>&1)"
RC=$?
set -e
printf '%s\n' "$OUTPUT" | sed 's/^/  /'

# The agent treats a rejected POST as a survivable cycle failure and still
# exits 0 — correct for a daemon that must keep trying, wrong as a success
# signal here. So the SEND is what is checked, and both paths get the hints.
HINTS="  401 => OPS_INGEST_SECRET does not match the CRM's
  403 => OPS_HOST_NAME is not in the CRM's OPS_INGEST_HOSTS
  503 => the CRM has no OPS_INGEST_SECRET / OPS_INGEST_HOSTS set
  ECONNREFUSED / timeout => OPS_INGEST_URL wrong, or the box cannot reach the CRM"

[ $RC -eq 0 ] || die "the agent exited $RC — fix the above before daemonising.
$HINTS"

printf '%s' "$OUTPUT" | grep -q "sent .* metrics" \
  || die "the agent ran but never completed a send, so nothing would reach the
  console. The line beginning '[ops-agent] cycle failed:' above says why.
$HINTS"

if printf '%s' "$OUTPUT" | grep -q "none of the configured log files are readable"; then
  say ""
  say "WARNING: no log file is readable, so Logs & Errors will stay empty."
  say "Host metrics will still work. Fix OPS_LOG_DIR / permissions and re-run."
fi

# ---------------------------------------------------------------------------
head_ "5. Daemonise"

if [ "$DRY_RUN" = "1" ]; then
  say "--dry-run: stopping here. Nothing was started."
  exit 0
fi
if [ "$HAVE_PM2" != "1" ]; then
  say "pm2 not installed — nothing daemonised. Use the cron recipe in README.md."
  exit 0
fi

# delete-then-start rather than restart: `pm2 restart` keeps the ORIGINAL
# environment, so a config change would appear to apply and silently not.
if pm2 describe ops-agent >/dev/null 2>&1; then
  say "existing ops-agent found — removing so the new env is picked up"
  pm2 delete ops-agent >/dev/null
fi

pm2 start ecosystem.ops-agent.config.js --update-env
pm2 save
say "started and saved (survives reboot)"

# ---------------------------------------------------------------------------
head_ "Done — verify"

say "pm2 logs ops-agent --lines 30"
say "then open /operations/infrastructure — host '$OPS_HOST_NAME' should appear"
say "within ~5 minutes, and 'Agent last seen' should stay under 15."
say ""
say "Logs & Errors fills only as NEW lines are written: the agent starts at the"
say "end of each file, so it never backfills history. If the box is quiet, it"
say "stays empty and that is correct."
