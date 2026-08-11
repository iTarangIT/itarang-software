// ecosystem.sandbox.config.js
// pm2 config for the Hostinger VPS sandbox deployment.
// Managed by .github/workflows/deploy-sandbox.yml — do not edit on the server.
module.exports = {
  apps: [
    {
      name: "sandbox-web",
      cwd: __dirname,
      // Next.js standalone output: run the bundled server.js directly.
      // `next start` is incompatible with output: "standalone" in next.config.ts
      // — it can't find the chunks/manifests the standalone build lays out.
      //
      // `current/` is a symlink maintained by .github/workflows/deploy-sandbox.yml
      // pointing at the latest shipped release under releases/<sha>/standalone.
      // Atomic symlink swap on deploy means pm2 reload re-execs server.js from
      // the new release without ever seeing a broken state.
      script: "node",
      args: "current/server.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: "3003",
        HOSTNAME: "127.0.0.1",
        // Headless-Chromium PDF rendering (Initiate Agreement, KYC consent,
        // audit trail) launches this binary via puppeteer-core. Pinned here so
        // the runtime path is explicit and matches what scripts/sandbox-system-
        // setup.sh installs — instead of silently depending on the deployed
        // .env, and instead of falling back to a bundled Chromium the
        // standalone build never ships. Production sets the same value.
        PUPPETEER_EXECUTABLE_PATH: "/usr/bin/google-chrome-stable",
        // What this process announces as `application_name` on every Postgres
        // connection it opens, so /operations/database can attribute
        // connections to a service. MUST match `name` above.
        //
        // Sandbox, production and the worker all run on this one VPS and reach
        // the same RDS from the same IP, so client_addr cannot separate them.
        // Without this they collapse into one `postgres.js` row and an
        // operator cannot tell which service is holding the connections.
        //
        // Read by src/lib/db/applicationName.ts. Requires `pm2 reload
        // --update-env` to take effect.
        OPS_APP_NAME: "sandbox-web",
      },
      max_memory_restart: "700M",
      // Give Next 8s to close its listener gracefully before SIGKILL. The
      // default 1.6s isn't enough — partial shutdowns leak the port and the
      // next restart EADDRINUSEs, which is how the stale-process bug got a
      // foothold on every memory-triggered restart.
      kill_timeout: 8000,
      restart_delay: 3000,
      min_uptime: 10000,
      max_restarts: 10,
      merge_logs: true,
      time: true,
      out_file: "logs/web.out.log",
      error_file: "logs/web.err.log",
    },
    {
      name: "sandbox-worker",
      cwd: __dirname,
      script: "./node_modules/.bin/tsx",
      args: "--env-file=.env src/lib/queue/callWorker.ts",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        // Same purpose as sandbox-web above; MUST match `name`. The worker
        // reaches Postgres transitively — callWorker.ts imports triggerCall
        // and pollCallStatus, both of which import @/lib/db at module load, so
        // a pool opens even on the runs where the BullMQ loop stays gated off.
        // Naming it is what separates worker connections from web connections
        // on the shared VPS IP.
        OPS_APP_NAME: "sandbox-worker",
      },
      // The worker is intentionally dormant: callWorker.ts gates its BullMQ
      // loop behind ENABLE_CALL_WORKER (unset here), so it logs "disabled" and
      // exits in <1s. With autorestart on, pm2 treated every exit as a crash
      // and relaunched it every ~3s — 1136 restarts in one log. Disable
      // autorestart so pm2 starts it once and leaves it stopped. Flip
      // ENABLE_CALL_WORKER=1 (and re-enable autorestart) to actually run it.
      autorestart: false,
      max_memory_restart: "500M",
      kill_timeout: 8000,
      restart_delay: 3000,
      min_uptime: 10000,
      max_restarts: 10,
      merge_logs: true,
      time: true,
      out_file: "logs/worker.out.log",
      error_file: "logs/worker.err.log",
    },
  ],
};
