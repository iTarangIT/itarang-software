import nodemailer from "nodemailer";
for (const [port, secure] of [[465, true], [587, false], [25, false]]) {
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 12000,
    tls: { rejectUnauthorized: false },
  });
  try { await t.verify(); console.log(`port ${port}: OK`); }
  catch (e) { console.log(`port ${port}: ${String(e.message).slice(0,90)}`); }
}
