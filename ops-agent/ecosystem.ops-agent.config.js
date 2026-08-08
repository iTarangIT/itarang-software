/**
 * pm2 config for ops-agent.
 *
 * Deliberately a SEPARATE file from the repo's ecosystem.*.config.js. Those are
 * rewritten by the deploy workflow and point at `current/server.js`; the agent
 * must survive a deploy that is mid-flight — a monitoring process that restarts
 * with the thing it monitors is blind at exactly the moment it matters.
 *
 * Install (per box):
 *   pm2 start ecosystem.ops-agent.config.js
 *   pm2 save                # so it comes back after a reboot
 *
 * Env comes from the box's shared/.env, exported before pm2 start, or set
 * inline in `env` below. See README.md.
 */
module.exports = {
  apps: [
    {
      name: "ops-agent",
      cwd: __dirname,
      script: "agent.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        // Set these on the box. Left empty here so a copied-in file cannot
        // silently ship the wrong host name or a stale secret.
        OPS_INGEST_URL: process.env.OPS_INGEST_URL || "",
        OPS_INGEST_SECRET: process.env.OPS_INGEST_SECRET || "",
        OPS_HOST_NAME: process.env.OPS_HOST_NAME || "",
        OPS_CERT_DOMAIN: process.env.OPS_CERT_DOMAIN || "",
        OPS_INTERVAL_MS: process.env.OPS_INTERVAL_MS || "300000",
        // REQUIRED for application log forwarding. `cwd` above is the agent's
        // own directory (deliberately — it must survive a mid-flight deploy),
        // so a relative log path resolves next to THIS file, not next to the
        // CRM. Without OPS_LOG_DIR the agent tails nginx only and says so at
        // startup. Point it at the directory holding web.out.log.
        OPS_LOG_DIR: process.env.OPS_LOG_DIR || "",
      },
      // The agent is ~10 MB resident. Anything near this is a leak, and a
      // restart is the right response for a process with no in-memory state.
      max_memory_restart: "150M",
      restart_delay: 10000,
      min_uptime: 30000,
      // No max_restarts cap: unlike the web process, an agent that keeps
      // failing should keep trying. Its failures are visible as a rising
      // host.agent_age_min on /operations/infrastructure.
      merge_logs: true,
      time: true,
      out_file: "logs/ops-agent.out.log",
      error_file: "logs/ops-agent.err.log",
    },
  ],
};
