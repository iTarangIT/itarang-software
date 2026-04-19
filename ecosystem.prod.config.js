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
      merge_logs: true,
      time: true,
      out_file: "logs/web.out.log",
      error_file: "logs/web.err.log",
    },
  ],
};
