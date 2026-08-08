#!/usr/bin/env node
/**
 * ops-agent — the iTarang Ops Console host agent.
 *
 * Reads this box's vitals and POSTs them to the CRM. The CRM never SSHes into
 * anything; this push is the only way host metrics reach the dashboard.
 *
 * DEPENDENCY-FREE ON PURPOSE. It is copied to boxes that may not have this
 * repo's node_modules, it must keep running when a deploy is half-finished, and
 * a monitoring agent that can break its own install is not monitoring anything.
 * Node 18+ (global fetch, AbortSignal.timeout).
 *
 * Config (env):
 *   OPS_INGEST_URL      required, e.g. https://crm.itarang.com/api/operations/ingest/host
 *   OPS_INGEST_SECRET   required, must equal the CRM's OPS_INGEST_SECRET
 *   OPS_HOST_NAME       required, one of the names in the CRM's OPS_INGEST_HOSTS
 *   OPS_CERT_DOMAIN     optional, domain to check TLS expiry for; omit to skip
 *   OPS_INTERVAL_MS     optional, default 300000 (5 minutes)
 *   OPS_ONCE            optional, "1" runs a single cycle and exits (cron mode)
 *   OPS_LOG_FILES       optional, comma-separated `service:path` pairs to tail
 *   OPS_LOG_DIR         optional, base directory for RELATIVE paths in
 *                       OPS_LOG_FILES, and the location of the CRM's pm2 logs
 *   OPS_LOG_STATE_FILE  optional, where byte offsets are remembered
 *   OPS_LOG_MIN_LEVEL   optional, error|warn|info — default warn
 */

"use strict";

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const INGEST_URL = process.env.OPS_INGEST_URL;
const INGEST_SECRET = process.env.OPS_INGEST_SECRET;
const HOST_NAME = process.env.OPS_HOST_NAME;
const CERT_DOMAIN = process.env.OPS_CERT_DOMAIN || "";
const INTERVAL_MS = Number(process.env.OPS_INTERVAL_MS || 300000);
const RUN_ONCE = process.env.OPS_ONCE === "1";

/** Every shell-out is bounded: a hung `pm2 jlist` must not wedge the agent. */
const CMD_TIMEOUT_MS = 8000;
const POST_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Log forwarding
// ---------------------------------------------------------------------------

/**
 * Base directory for RELATIVE paths, and where the CRM's pm2 logs live.
 *
 * This exists because the old defaults could not work. They were written as
 * `logs/web.out.log` — relative, with a comment saying "relative to the pm2
 * cwd" — but ecosystem.ops-agent.config.js sets `cwd: __dirname` and the README
 * installs the agent to its own directory (deliberately, so it survives a
 * half-finished deploy). So those paths resolved to the AGENT's own log folder,
 * which contains ops-agent.out.log and nothing else. The agent would run
 * perfectly, post its metrics, forward zero application log lines, and say
 * nothing about it — because a missing log file is skipped silently, by design,
 * since nginx genuinely is absent on some boxes.
 *
 * The result was an empty Logs & Errors page with no diagnostic anywhere. Set
 * OPS_LOG_DIR to the CRM's log directory (the one holding web.out.log), or give
 * absolute paths in OPS_LOG_FILES.
 */
const LOG_DIR = process.env.OPS_LOG_DIR || "";

/**
 * `service:path` pairs.
 *
 * nginx is absolute and always included. The two pm2 files are only defaulted in
 * when OPS_LOG_DIR says where they are — a default that cannot resolve is worse
 * than no default, because it looks configured.
 */
const DEFAULT_LOG_FILES = [
  ...(LOG_DIR
    ? ["itarang-crm-web:web.out.log", "itarang-crm-web:web.err.log"]
    : []),
  "nginx:/var/log/nginx/error.log",
];

const LOG_FILES = (process.env.OPS_LOG_FILES || DEFAULT_LOG_FILES.join(","))
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    // Split on the FIRST colon only: a Windows-style or otherwise
    // colon-bearing path must not lose everything after it.
    const at = entry.indexOf(":");
    if (at < 1) return null;
    const service = entry.slice(0, at);
    const raw = entry.slice(at + 1);
    // Relative paths resolve against OPS_LOG_DIR when set; otherwise against
    // the cwd, which is what they did before — so an existing install that
    // relied on that keeps working rather than silently changing meaning.
    const file =
      path.isAbsolute(raw) || !LOG_DIR ? raw : path.join(LOG_DIR, raw);
    return { service, file };
  })
  .filter(Boolean);

/**
 * Where byte offsets live between runs.
 *
 * This file is the whole exactly-once story. Without it a cron-mode agent
 * re-sends its entire log file every five minutes, and the 14-day retention
 * fills with the same lines over and over.
 */
const LOG_STATE_FILE =
  process.env.OPS_LOG_STATE_FILE || path.join(__dirname, ".ops-agent-state.json");

/**
 * Default warn: web.out.log is request-level chatter on a busy box, and
 * forwarding info would blow the 200-line budget every cycle while burying the
 * errors this exists to surface. Set OPS_LOG_MIN_LEVEL=info deliberately.
 */
const LOG_MIN_LEVEL = (process.env.OPS_LOG_MIN_LEVEL || "warn").toLowerCase();
const LEVEL_RANK = { info: 0, warn: 1, error: 2 };

/** Server cap is 200 lines per POST; stay under it rather than get truncated. */
const MAX_LOG_LINES = 200;
/** Per file, per cycle. Bounds both memory and the POST body. */
const MAX_TAIL_BYTES = 256 * 1024;
const MAX_LOG_MESSAGE_CHARS = 2000;

function fail(message) {
  console.error(`[ops-agent] ${message}`);
  process.exit(1);
}

if (!INGEST_URL) fail("OPS_INGEST_URL is not set");
if (!INGEST_SECRET) fail("OPS_INGEST_SECRET is not set");
if (!HOST_NAME) fail("OPS_HOST_NAME is not set");

/**
 * Run a command and resolve its stdout, or resolve null on any failure.
 *
 * Never rejects. Each reader below is one metric; a box without `free`, or a
 * pm2 that is not installed, must cost us that metric and nothing else.
 */
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: CMD_TIMEOUT_MS, encoding: "utf8" },
      (err, stdout) => resolve(err ? null : String(stdout)),
    );
  });
}

function round(value, dp) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const f = Math.pow(10, dp);
  return Math.round(value * f) / f;
}

/** node:os — load, memory, uptime, CPU count. */
function readOsMetrics() {
  const cpus = os.cpus().length || 1;
  const load1 = os.loadavg()[0];
  const total = os.totalmem();
  const free = os.freemem();

  return {
    // The console's CPU number is load-over-cores, not an instantaneous
    // sample. os.cpus() times are cumulative since boot, so a single reading
    // of them describes the whole uptime rather than "now" — load average is
    // the honest one-shot answer.
    cpu_pct: round(Math.min(100, (load1 / cpus) * 100), 1),
    load1: round(load1, 2),
    mem_used_pct: total > 0 ? round(((total - free) / total) * 100, 1) : undefined,
    uptime_s: Math.round(os.uptime()),
  };
}

/**
 * Parse a POSIX `df -P` data line into { total, used, available, capacity }.
 *
 * NOT a plain whitespace split on field index. The Filesystem column can
 * contain spaces (a labelled mount, or `C:/Program Files/Git` under MSYS),
 * which shifts every subsequent field and yields a "disk 385144788% full"
 * reading rather than an error. Anchoring on the four numeric columns followed
 * by `N%` is the part of the format POSIX actually guarantees.
 */
function parseDfLine(out) {
  if (!out) return null;
  const line = out.trim().split("\n")[1];
  if (!line) return null;
  const m = line.match(/(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%/);
  if (!m) return null;
  return {
    total: Number(m[1]),
    used: Number(m[2]),
    available: Number(m[3]),
    capacity: Number(m[4]),
  };
}

/** `df -P -k /` → disk used %, free GB. */
async function readDisk() {
  const df = parseDfLine(await run("df", ["-P", "-k", "/"]));
  if (!df) return {};
  return {
    disk_used_pct: Number.isFinite(df.capacity) ? df.capacity : undefined,
    disk_free_gb: Number.isFinite(df.available)
      ? round(df.available / 1024 / 1024, 1)
      : undefined,
  };
}

/**
 * `df -P -i /` → inode used %.
 *
 * Separate from the block reading because inode exhaustion looks exactly like a
 * full disk to the app while df shows free space — usually millions of small
 * files. Without this metric that outage has no signal at all.
 */
async function readInodes() {
  const df = parseDfLine(await run("df", ["-P", "-i", "/"]));
  if (!df) return {};
  return {
    inode_used_pct: Number.isFinite(df.capacity) ? df.capacity : undefined,
  };
}

/** `free -m` → swap used %. Any sustained swap on these boxes is memory pressure. */
async function readSwap() {
  const out = await run("free", ["-m"]);
  if (!out) return {};
  const line = out.split("\n").find((l) => /^Swap:/i.test(l.trim()));
  if (!line) return {};
  const cols = line.trim().split(/\s+/);
  const total = Number(cols[1]);
  const used = Number(cols[2]);
  if (!Number.isFinite(total) || total <= 0) return { swap_used_pct: 0 };
  return { swap_used_pct: round((used / total) * 100, 1) };
}

/** `pm2 jlist` → one entry per managed process. */
async function readProcesses() {
  const out = await run("pm2", ["jlist"]);
  if (!out) return [];
  let list;
  try {
    // pm2 sometimes prefixes the JSON with an update banner; take from the
    // first '[' so a chatty pm2 does not cost us the whole process table.
    const start = out.indexOf("[");
    list = start >= 0 ? JSON.parse(out.slice(start)) : null;
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];

  return list.slice(0, 100).map((p) => {
    const env = p.pm2_env || {};
    const monit = p.monit || {};
    return {
      name: String(p.name || "unknown").slice(0, 80),
      status: String(env.status || "unknown").slice(0, 32),
      restarts: Number(env.restart_time || 0),
      mem_mb: round(Number(monit.memory || 0) / 1024 / 1024, 1),
      cpu_pct: round(Number(monit.cpu || 0), 1),
      uptime_s: env.pm_uptime
        ? Math.max(0, Math.round((Date.now() - Number(env.pm_uptime)) / 1000))
        : undefined,
    };
  });
}

/**
 * Days until the served certificate expires.
 *
 * Checks the cert the domain actually serves rather than a file on disk: a
 * renewed file that nginx was never reloaded to pick up is precisely the
 * failure this is meant to catch, and reading the file would report the happy
 * number while the site served the expired one.
 */
async function readCertDaysLeft() {
  if (!CERT_DOMAIN) return {};
  const out = await run("sh", [
    "-c",
    `echo | openssl s_client -servername ${CERT_DOMAIN} -connect ${CERT_DOMAIN}:443 2>/dev/null | openssl x509 -noout -enddate`,
  ]);
  if (!out) return {};
  const match = out.match(/notAfter=(.+)/);
  if (!match) return {};
  const expiry = Date.parse(match[1].trim());
  if (Number.isNaN(expiry)) return {};
  return {
    cert_days_left: Math.floor((expiry - Date.now()) / 86400000),
  };
}

// ---------------------------------------------------------------------------
// Log tailing
// ---------------------------------------------------------------------------

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LOG_STATE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // No state file yet, or it is corrupt. Either way, start fresh — see
    // tailFile() for why a fresh start seeks to the END rather than the top.
    return {};
  }
}

function writeState(state) {
  try {
    // Write-and-rename so a crash mid-write cannot leave a truncated state
    // file, which would re-send an entire log on the next cycle.
    const tmp = `${LOG_STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
    fs.renameSync(tmp, LOG_STATE_FILE);
  } catch (e) {
    console.error(`[ops-agent] could not persist log offsets: ${e.message}`);
  }
}

/**
 * Level for one raw line, most explicit signal first.
 *
 * The order is the whole point. A line that SAYS what it is beats any guess
 * about it: an `INFO` line on web.err.log is info, even though the stream it
 * arrived on suggests otherwise. Getting that backwards forwards routine
 * chatter as warnings and buries the real errors — which is the failure this
 * page exists to prevent.
 *
 * The explicit-token match is case-SENSITIVE on purpose. Log levels are written
 * in caps by convention, while the prose word "error" appears in plenty of
 * innocent sentences ("completed with no error"). Requiring caps keeps the
 * strong signal strong.
 */
function detectLevel(line, file) {
  // 1. nginx: `2026/08/04 12:00:00 [error] 1234#0: ...`
  const nginx = line.match(/\[(emerg|alert|crit|error|warn|notice|info)\]/i);
  if (nginx) return nginx[1].toLowerCase();

  // 2. An explicit uppercase level token, as most structured loggers emit.
  const explicit = line.match(
    /\b(TRACE|DEBUG|INFO|NOTICE|WARNING|WARN|ERROR|FATAL|CRITICAL|CRIT)\b/,
  );
  if (explicit) return explicit[1].toLowerCase();

  // 3. Unlabelled lines: a bare stack trace, a thrown rejection. `\b` keeps
  //    "TypeError" out of this — it is caught by the stream rule below.
  if (/\b(error|exception|unhandled|fatal)\b/i.test(line)) return "error";
  if (/\bwarn(ing)?\b/i.test(line)) return "warn";

  // 4. Last resort: pm2 routes stderr to *.err.log, so an unlabelled line
  //    there is still worth seeing.
  if (/\.err\.log$/.test(file)) return "warn";
  return "info";
}

/** Leading timestamp, if the line has one. pm2 `time: true` and nginx both do. */
function detectTimestamp(line) {
  const iso = line.match(
    /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/,
  );
  if (iso) {
    const at = Date.parse(iso[0]);
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  // nginx: 2026/08/04 12:00:00
  const nginx = line.match(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2})/);
  if (nginx) {
    const at = Date.parse(`${nginx[1]}-${nginx[2]}-${nginx[3]}T${nginx[4]}`);
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  return undefined;
}

/**
 * Read one file from its remembered byte offset to EOF.
 *
 * Offsets, not `tail -n`: a five-minute cycle must ship every line written in
 * between exactly once, and a line count cannot express that.
 *
 * Three cases the offset alone cannot handle:
 *
 *   · First sight of a file — seek to the END. Forwarding a months-old log on
 *     install would bury today's errors and blow through the 14-day retention
 *     in one POST.
 *   · Rotation — the file is now SHORTER than the offset, so logrotate moved it
 *     and started a new one. Restart from 0.
 *   · A burst larger than MAX_TAIL_BYTES — read the most recent window and skip
 *     the rest, counting what was dropped. Never allocate an unbounded buffer just
 *     because something logged in a loop; that is the failure mode this whole
 *     console exists to catch.
 */
function tailFile(entry, state) {
  const { service, file } = entry;
  const result = { lines: [], dropped: 0 };

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    // Missing file is normal: nginx is not on every box, and pm2 has not
    // created web.err.log until something writes to stderr.
    return result;
  }

  const previous = state[file];
  if (previous == null) {
    state[file] = stat.size;
    return result;
  }

  let from = previous;
  if (stat.size < previous) from = 0; // rotated
  if (stat.size === from) return result; // nothing new

  if (stat.size - from > MAX_TAIL_BYTES) {
    result.dropped = stat.size - from - MAX_TAIL_BYTES;
    from = stat.size - MAX_TAIL_BYTES;
  }

  let chunk = "";
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(stat.size - from);
    const read = fs.readSync(fd, buffer, 0, buffer.length, from);
    chunk = buffer.subarray(0, read).toString("utf8");
  } catch (e) {
    console.error(`[ops-agent] could not read ${file}: ${e.message}`);
    return result;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }

  state[file] = stat.size;

  const raw = chunk.split("\n");
  // A final line with no newline is half-written; leave it for the next cycle
  // by rewinding the offset past it, so it ships whole rather than truncated.
  if (chunk.length > 0 && !chunk.endsWith("\n")) {
    const partial = raw.pop() ?? "";
    state[file] = stat.size - Buffer.byteLength(partial, "utf8");
  }

  for (const line of raw) {
    const text = line.trim();
    if (!text) continue;

    const level = detectLevel(text, file);
    if (LEVEL_RANK[level] < LEVEL_RANK[LOG_MIN_LEVEL]) continue;

    result.lines.push({
      ts: detectTimestamp(text),
      service,
      level,
      message: text.slice(0, MAX_LOG_MESSAGE_CHARS),
    });
  }

  return result;
}

/**
 * Every configured file, tailed, budget-capped.
 *
 * Returns the lines AND the advanced offsets, without persisting them. The
 * caller commits only after the POST succeeds — otherwise a CRM that was down
 * for one cycle would cost us those log lines permanently, which is exactly
 * when the logs matter most. Leaving the offsets alone means the next cycle
 * re-reads the same bytes, and MAX_TAIL_BYTES bounds how far the backlog can
 * grow while the CRM stays unreachable.
 *
 * When more lines qualify than the server will accept, the NEWEST are kept:
 * during an incident the last 200 lines describe what is happening now, and the
 * first 200 describe how it started five minutes ago.
 */
function readLogs() {
  if (LOG_FILES.length === 0) return { lines: [], state: null };

  const state = readState();
  let lines = [];
  let dropped = 0;

  for (const entry of LOG_FILES) {
    const result = tailFile(entry, state);
    lines = lines.concat(result.lines);
    dropped += result.dropped;
  }

  if (dropped > 0) {
    console.error(
      `[ops-agent] skipped ${dropped} bytes of log backlog (over ${MAX_TAIL_BYTES} per file)`,
    );
  }

  if (lines.length > MAX_LOG_LINES) {
    const overflow = lines.length - MAX_LOG_LINES;
    lines = lines.slice(-MAX_LOG_LINES);
    console.error(`[ops-agent] dropped ${overflow} log lines over the per-post cap`);
  }

  return { lines, state };
}

async function collect() {
  const [disk, inodes, swap, cert, processes] = await Promise.all([
    readDisk(),
    readInodes(),
    readSwap(),
    readCertDaysLeft(),
    readProcesses(),
  ]);

  const metrics = Object.assign(
    {},
    readOsMetrics(),
    disk,
    inodes,
    swap,
    cert,
  );
  // Drop undefined so the server sees "not measured" rather than a zero it
  // would render as a real reading.
  for (const key of Object.keys(metrics)) {
    if (metrics[key] === undefined) delete metrics[key];
  }

  const logs = readLogs();

  return {
    payload: {
      host: HOST_NAME,
      captured_at: new Date().toISOString(),
      metrics,
      processes,
      logs: logs.lines,
    },
    // Committed by cycle() only once the POST has succeeded.
    logState: logs.state,
  };
}

async function post(payload) {
  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INGEST_SECRET}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return text;
}

async function cycle() {
  try {
    const { payload, logState } = await collect();
    await post(payload);

    // Only now are the log lines definitely somewhere else. Advancing the
    // offsets before this point would lose them whenever the CRM was down —
    // the one time you most want the logs.
    if (logState) writeState(logState);

    console.log(
      `[ops-agent] sent ${Object.keys(payload.metrics).length} metrics, ` +
        `${payload.processes.length} processes, ${payload.logs.length} log lines ` +
        `for host=${payload.host}`,
    );
  } catch (e) {
    // Log and carry on. Metrics are re-read from scratch next cycle, and the
    // log offsets were deliberately not advanced, so those lines ship then.
    console.error(`[ops-agent] cycle failed: ${e && e.message ? e.message : e}`);
  }
}

/**
 * Say once, at startup, which log files were found and which were not.
 *
 * A missing log file is skipped silently during a cycle and that is correct —
 * nginx is not on every box and pm2 has not created web.err.log until something
 * writes to stderr, so warning every five minutes forever would be noise. But
 * silence for the WHOLE configuration is how an agent ends up posting metrics
 * happily while forwarding nothing, with an empty Logs & Errors page and no
 * clue anywhere as to why.
 *
 * Once at startup costs nothing and is printed by the README's `OPS_ONCE=1`
 * smoke test, which is exactly when somebody is looking.
 */
function reportLogFiles() {
  if (LOG_FILES.length === 0) {
    console.error(
      "[ops-agent] no log files configured — set OPS_LOG_FILES, or OPS_LOG_DIR " +
        "to the directory holding the CRM's web.out.log. No log lines will be forwarded.",
    );
    return;
  }

  let found = 0;
  for (const { service, file } of LOG_FILES) {
    let note;
    try {
      fs.accessSync(file, fs.constants.R_OK);
      note = "ok";
      found++;
    } catch (e) {
      // ENOENT is "not there yet", EACCES is "there but this user cannot read
      // it" — a different fix, so name them differently.
      note =
        e && e.code === "EACCES"
          ? "NOT READABLE by this user"
          : "not found (will be picked up if it appears)";
    }
    console.log(`[ops-agent] log ${service}: ${file} — ${note}`);
  }

  if (found === 0) {
    console.error(
      "[ops-agent] none of the configured log files are readable — Logs & Errors " +
        "will stay empty. Check OPS_LOG_DIR / OPS_LOG_FILES, and that this user " +
        "can read them.",
    );
  }
  if (!process.env.OPS_LOG_FILES && !LOG_DIR) {
    console.error(
      "[ops-agent] OPS_LOG_DIR is not set, so only nginx is being tailed — the " +
        "CRM's own pm2 logs are NOT. Set OPS_LOG_DIR to the directory holding " +
        "web.out.log.",
    );
  }
}

async function main() {
  if (RUN_ONCE) {
    reportLogFiles();
    await cycle();
    return;
  }

  console.log(
    `[ops-agent] host=${HOST_NAME} interval=${Math.round(INTERVAL_MS / 1000)}s -> ${INGEST_URL}`,
  );
  reportLogFiles();
  await cycle();
  setInterval(cycle, INTERVAL_MS);
}

main();
