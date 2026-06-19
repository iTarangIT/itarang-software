// Temporary — screenshots the redesigned /leads tabs + date filter row.
const { chromium } = require("@playwright/test");
const BASE = "http://localhost:3000";
const EMAIL = process.env.E2E_CEO_EMAIL || "ceo.itarang@gmail.com";
const PASSWORD = process.env.E2E_CEO_PASSWORD || "password";

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  try {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.locator('input[name="email"]').fill(EMAIL);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click({ force: true });
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
    await page.goto(`${BASE}/leads`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Leads", exact: true }).click().catch(() => {});
    await page.waitForSelector('input[type="date"]', { timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "leads-ui-default.png" });
    console.log("default shot saved");

    // Click "This month" preset and capture cards
    await page.getByRole("button", { name: "This month" }).click();
    await page.waitForTimeout(1800);
    const cards = await page.$$eval("div.grid.grid-cols-5 > div", (els) =>
      els.map((e) => { const p = e.querySelectorAll("p"); return `${p[0]?.textContent?.trim()}=${p[1]?.textContent?.trim()}`; }).join(", "));
    console.log("THIS MONTH cards:", cards);
    await page.screenshot({ path: "leads-ui-thismonth.png" });
    console.log("this-month shot saved");
  } catch (e) {
    console.log("ERROR:", e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
