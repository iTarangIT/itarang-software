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
      merge_logs: true,
      time: true,
      out_file: "logs/web.out.log",
      error_file: "logs/web.err.log",
    },
    {
      name: "sandbox-worker",
      cwd: __dirname,
      script: "./node_modules/.bin/tsx",
      args: "src/lib/queue/callWorker.ts",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
      max_memory_restart: "500M",
      merge_logs: true,
      time: true,
      out_file: "logs/worker.out.log",
      error_file: "logs/worker.err.log",
    },
  ],
};
