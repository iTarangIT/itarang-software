module.exports = {
  apps: [
    {
      name: "itarang-crm-web",
      cwd: __dirname,
      // `current/` is an atomic symlink maintained by .github/workflows/deploy-
      // production.yml pointing at the latest shipped release under
      // releases/<sha>/standalone. Atomic symlink swap on deploy means pm2 re-execs
      // server.js from the new release without ever seeing a broken state. Run the
      // bundled standalone server.js directly — `next start` is incompatible with
      // output: "standalone" in next.config.ts.
      script: "node",
      args: "current/server.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: "3002",
        HOSTNAME: "127.0.0.1",
        PUPPETEER_EXECUTABLE_PATH: "/usr/bin/google-chrome-stable",
        // What this process announces as `application_name` on every Postgres
        // connection it opens, so /operations/database can attribute
        // connections to a service. MUST match `name` above.
        //
        // Production and sandbox run on the SAME VPS and connect to the same
        // RDS from the same IP, so client_addr cannot tell them apart —
        // without this they collapse into one indistinguishable `postgres.js`
        // row against a 79-connection ceiling. Declared here rather than
        // sniffed from pm2's own environment because pm2's `name` variable is
        // an undocumented internal, and pm2 is not a dependency of this repo,
        // so nothing here can verify it.
        //
        // Read by src/lib/db/applicationName.ts. Requires `pm2 reload
        // --update-env` (or delete+start) to take effect — a plain reload does
        // not re-read this block.
        OPS_APP_NAME: "itarang-crm-web",
      },
      max_memory_restart: "900M",
      // Give Next 8s to close its listener gracefully before SIGKILL. The
      // default 1.6s isn't enough — partial shutdowns leak the port and the
      // next restart EADDRINUSEs, which leaves the old process serving
      // stale HTML against the new .next build.
      kill_timeout: 8000,
      restart_delay: 3000,
      min_uptime: 10000,
      max_restarts: 10,
      merge_logs: true,
      time: true,
      out_file: "logs/web.out.log",
      error_file: "logs/web.err.log",
    },
  ],
};
