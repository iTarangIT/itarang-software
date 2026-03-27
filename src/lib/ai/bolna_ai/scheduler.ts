setInterval(async () => {
  try {
    await fetch("http://localhost:3000/api/cron/call");
    console.log("Scheduler tick...");
  } catch (err) {
    console.error("Scheduler error:", err);
  }
}, 60000);
