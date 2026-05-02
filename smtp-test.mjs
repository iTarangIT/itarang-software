import nodemailer from "nodemailer";

const config = {
  host: "smtp.hostinger.com",
  port: 465,
  secure: true,
  auth: {
    user: "it@itarang.com",
    pass: "MYitarang@2026",
  },
};

const TO = "rushikeshkasav1@gmail.com";
const FROM = "iTarang Admin <it@itarang.com>";

console.log("=== SMTP TEST START ===");
console.log("Host:", config.host, "Port:", config.port, "User:", config.auth.user);

const transporter = nodemailer.createTransport(config);

try {
  console.log("\n[1/2] Verifying SMTP connection...");
  await transporter.verify();
  console.log("✅ SMTP connection verified — credentials accepted by Hostinger.");
} catch (err) {
  console.error("❌ SMTP verify FAILED:");
  console.error("  code:", err.code);
  console.error("  command:", err.command);
  console.error("  responseCode:", err.responseCode);
  console.error("  message:", err.message);
  process.exit(1);
}

try {
  console.log("\n[2/2] Sending test email to", TO, "...");
  const info = await transporter.sendMail({
    from: FROM,
    to: TO,
    subject: "iTarang SMTP Test — " + new Date().toISOString(),
    text:
      "This is a test email sent directly via nodemailer to verify Hostinger SMTP credentials.\n\n" +
      "If you received this in your inbox (or spam folder), Hostinger SMTP is working from this machine.\n\n" +
      "Host: smtp.hostinger.com\nPort: 465\nUser: it@itarang.com\nFrom: " + FROM + "\nTime: " + new Date().toISOString(),
    html:
      "<p>This is a test email sent directly via nodemailer to verify Hostinger SMTP credentials.</p>" +
      "<p>If you received this in your <b>inbox</b> (or <b>spam folder</b>), Hostinger SMTP is working from this machine.</p>" +
      "<ul><li>Host: smtp.hostinger.com</li><li>Port: 465</li><li>User: it@itarang.com</li><li>From: " + FROM + "</li><li>Time: " + new Date().toISOString() + "</li></ul>",
  });

  console.log("✅ sendMail completed.");
  console.log("  messageId:", info.messageId);
  console.log("  response:", info.response);
  console.log("  accepted:", info.accepted);
  console.log("  rejected:", info.rejected);
  console.log("  envelope:", info.envelope);
} catch (err) {
  console.error("❌ sendMail FAILED:");
  console.error("  code:", err.code);
  console.error("  command:", err.command);
  console.error("  responseCode:", err.responseCode);
  console.error("  message:", err.message);
  process.exit(1);
}

console.log("\n=== SMTP TEST DONE ===");
console.log("Now check the inbox AND spam folder of " + TO);
