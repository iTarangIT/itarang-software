module.exports = {
  apps: [
    {
      name: "itarang-crm-web",
      cwd: __dirname,
      script: "./.next/standalone/server.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: "3002",
        HOSTNAME: "127.0.0.1",
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
