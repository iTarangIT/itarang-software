setInterval(async () => {
  try {
    // /api/cron/call checks the CRON_SECRET bearer like every other cron route
    // (tracker ID 118).
    await fetch("http://localhost:3000/api/cron/call", {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
    });
    console.log("Scheduler tick...");
  } catch (err) {
    console.error("Scheduler error:", err);
  }
}, 60000);
