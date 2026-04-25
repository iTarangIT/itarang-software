// ecosystem.sandbox.config.js
// pm2 config for the Hostinger VPS sandbox deployment.
// Managed by .github/workflows/deploy-sandbox.yml — do not edit on the server.

module.exports = {
  apps: [
    {
      name: "sandbox-web",
      cwd: __dirname,
      script: "./node_modules/next/dist/bin/next",
      args: "start -p 3003 -H 127.0.0.1",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: "3003",
        HOSTNAME: "127.0.0.1",
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
      },
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
