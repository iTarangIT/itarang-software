/**
 * E-278 — drive the "Team Leads" + "History" dealer-console features end to
 * end against a real DB.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-whatsapp-team-leads.ts \
 *     <DEALER-WA-PHONE> --i-understand-this-mutates
 *
 * <DEALER-WA-PHONE> is an APPROVED dealer's WhatsApp number (digits, e.g.
 * 919876543210). Same harness as verify-whatsapp-team.ts: WA_DRY_RUN=1 swaps
 * the Meta adapter for the capture stub, set BEFORE the orchestrator import
 * because getAdapter() caches. THIS SCRIPT MUTATES: it adds/removes a
 * synthetic salesperson, drives both chats, and creates one customer lead.
 * Best-effort cleanup at the end deletes what it created — never point it at
 * production.
 *
 * What it asserts:
 *   1. E-278 applied (lead_flow_events reachable) — hard requirement here.
 *   2. Dealer menu shows Team Leads + History; the salesperson menu shows
 *      neither, and a stale menu_team_leads tap from the salesperson bounces.
 *   3. A lead driven from the salesperson chat writes 'created' + ≥1 'state'
 *      event with actor_kind='salesperson'.
 *   4. Team Leads lists the lead with the salesperson's name; the card renders
 *      with Take over / History buttons.
 *   5. Take over resumes the draft in the DEALER's chat (cash ladder → name
 *      prompt) and writes a 'takeover' event with actor_kind='dealer'.
 *   6. History renders creation line + salesperson steps + the takeover.
 */

process.env.WA_DRY_RUN = "1";

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];
let failed = 0;

function pass(name: string, detail = "") {
  steps.push({ name, ok: true, detail });
  console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name: string, detail: string) {
  steps.push({ name, ok: false, detail });
  failed += 1;
  console.log(`  ✖ ${name} — ${detail}`);
}

async function main() {
  const dealerWaPhone = (process.argv[2] || "").replace(/\D/g, "");
  const confirmed = process.argv.includes("--i-understand-this-mutates");
  if (!dealerWaPhone || !confirmed) {
    console.error(
      "usage: verify-whatsapp-team-leads.ts <DEALER-WA-PHONE> --i-understand-this-mutates\n\n" +
        "This script WRITES: it adds/removes a synthetic salesperson and creates one lead.",
    );
    process.exit(2);
  }

  const { db } = await import("@/lib/db");
  const { desc, eq } = await import("drizzle-orm");
  const schema = await import("@/lib/db/schema");
  const { runTurn } = await import("@/lib/whatsapp/orchestrator");
  const { dryRunSends, dryRunClear } = await import("@/lib/whatsapp/dry-run");
  const { resolveWhatsAppDealer } = await import("@/lib/whatsapp/dealer-identity");
  const { addSalesperson } = await import("@/lib/team/salespersons");
  const { resolveSalesperson } = await import("@/lib/whatsapp/salesperson-identity");

  console.log("DB HOST:", new URL(process.env.DATABASE_URL ?? "http://none").hostname);

  // ---- 0. E-278 present? ---------------------------------------------------
  try {
    await db.select({ id: schema.leadFlowEvents.id }).from(schema.leadFlowEvents).limit(1);
    pass("lead_flow_events table reachable");
  } catch {
    console.error(
      "lead_flow_events is missing — apply drizzle/E-278_lead_flow_events.sql first\n" +
        "(node scripts/apply-migration.mjs drizzle/E-278_lead_flow_events.sql).",
    );
    process.exit(1);
  }

  const dealer = await resolveWhatsAppDealer(dealerWaPhone);
  if (!dealer?.dealerCode || !dealer.dealerUserId) {
    console.error("That number does not resolve to an approved/active dealer.");
    process.exit(1);
  }
  console.log(`DEALER : ${dealer.dealerCode} (${dealer.dealerName ?? "?"})\n`);

  const spPhone = `9193${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const custMobile = `98${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  console.log(`SP     : ${spPhone}\nCUST   : ${custMobile}\n`);

  let seq = 0;
  async function send(
    fromPhone: string,
    text: string,
    type: "interactive" | "text" = "interactive",
  ) {
    dryRunClear();
    seq += 1;
    await runTurn({
      providerMessageId: `verify-tl-${Date.now()}-${seq}`,
      waPhone: fromPhone,
      type,
      text,
      raw: { synthetic: true },
    } as Parameters<typeof runTurn>[0]);
    return dryRunSends();
  }
  function lastRows(sends: readonly { rows?: { id: string; title: string; description?: string }[] }[]) {
    for (let i = sends.length - 1; i >= 0; i -= 1) {
      if (sends[i].rows?.length) return sends[i].rows!;
    }
    return [];
  }
  function bodies(sends: readonly { body?: string }[]) {
    return sends.map((s) => String(s.body ?? "")).join("\n---\n");
  }
  async function sessionOf(phone: string) {
    const [s] = await db
      .select()
      .from(schema.whatsappOnboardingSessions)
      .where(eq(schema.whatsappOnboardingSessions.wa_phone, phone))
      .orderBy(desc(schema.whatsappOnboardingSessions.updated_at))
      .limit(1);
    return s;
  }
  async function eventsOf(leadId: string) {
    return await db
      .select()
      .from(schema.leadFlowEvents)
      .where(eq(schema.leadFlowEvents.lead_id, leadId))
      .orderBy(schema.leadFlowEvents.created_at);
  }

  const cleanup: Array<() => Promise<void>> = [];

  // The drive mutates the DEALER's real session (state, ctx). Snapshot and
  // restore so their chat resumes untouched.
  const dealerSessionBefore = await sessionOf(dealerWaPhone);
  if (dealerSessionBefore) {
    cleanup.push(async () => {
      await db
        .update(schema.whatsappOnboardingSessions)
        .set({
          current_state: dealerSessionBefore.current_state,
          context: dealerSessionBefore.context,
          updated_at: new Date(),
        })
        .where(eq(schema.whatsappOnboardingSessions.id, dealerSessionBefore.id));
      console.log("  dealer session state restored");
    });
  }

  try {
    // ---- 1. Menus ----------------------------------------------------------
    console.log("1 · Menu wiring");
    {
      const rows = lastRows(await send(dealerWaPhone, "menu"));
      const ids = rows.map((r) => r.id);
      if (ids.includes("menu_team_leads") && ids.includes("menu_history"))
        pass("dealer menu shows Team Leads + History");
      else fail("dealer menu shows Team Leads + History", ids.join(","));
      if (rows.length <= 10) pass("dealer menu within Meta's 10-row cap", `${rows.length} rows`);
      else fail("dealer menu within Meta's 10-row cap", `${rows.length} rows`);
    }

    // ---- 2. Seed a salesperson + their lead --------------------------------
    console.log("\n2 · Salesperson creates a lead");
    const added = await addSalesperson({
      dealerCode: dealer.dealerCode,
      phone: spPhone,
      displayName: "Verify Salesperson",
      addedBy: null,
      addedVia: "admin",
    });
    if (!added.ok) throw new Error(`addSalesperson failed: ${JSON.stringify(added)}`);
    const sp = await resolveSalesperson(spPhone);
    if (!sp) throw new Error("salesperson row missing");
    cleanup.push(async () => {
      await db
        .delete(schema.dealerSalespersons)
        .where(eq(schema.dealerSalespersons.wa_phone, spPhone));
    });
    cleanup.push(async () => {
      const sessions = await db
        .select({ id: schema.whatsappOnboardingSessions.id })
        .from(schema.whatsappOnboardingSessions)
        .where(eq(schema.whatsappOnboardingSessions.wa_phone, spPhone));
      for (const s of sessions) {
        await db
          .delete(schema.whatsappMessages)
          .where(eq(schema.whatsappMessages.session_id, s.id));
      }
      await db
        .delete(schema.whatsappOnboardingSessions)
        .where(eq(schema.whatsappOnboardingSessions.wa_phone, spPhone));
    });

    {
      const spMenu = lastRows(await send(spPhone, "hi"));
      const ids = spMenu.map((r) => r.id);
      if (!ids.includes("menu_team_leads") && !ids.includes("menu_history"))
        pass("salesperson menu hides Team Leads/History", ids.join(","));
      else fail("salesperson menu hides Team Leads/History", ids.join(","));

      // Stale/forged tap from the salesperson chat must bounce to their menu.
      const bounce = lastRows(await send(spPhone, "menu_team_leads"));
      if (!bounce.some((r) => r.id.startsWith("tl:")) && bounce.some((r) => r.id === "menu_new_lead"))
        pass("salesperson menu_team_leads tap bounces");
      else fail("salesperson menu_team_leads tap bounces", bounce.map((r) => r.id).join(","));
    }

    let leadId: string | null = null;
    {
      for (const msg of ["menu_new_lead", custMobile, "interest_hot", "pay_cash"]) {
        await send(spPhone, msg, msg === custMobile ? "text" : "interactive");
      }
      const [lead] = await db
        .select({ id: schema.leads.id, salesperson_id: schema.leads.salesperson_id })
        .from(schema.leads)
        .where(eq(schema.leads.mobile, `+91${custMobile.slice(-10)}`))
        .orderBy(desc(schema.leads.created_at))
        .limit(1);
      if (lead) {
        leadId = lead.id;
        cleanup.push(async () => {
          await db.delete(schema.leadFlowEvents).where(eq(schema.leadFlowEvents.lead_id, lead.id));
          await db.delete(schema.personalDetails).where(eq(schema.personalDetails.lead_id, lead.id));
          await db.delete(schema.leads).where(eq(schema.leads.id, lead.id));
        });
        pass("lead created from salesperson chat", lead.id);
      } else {
        fail("lead created from salesperson chat", "no leads row");
      }

      if (leadId) {
        const evts = await eventsOf(leadId);
        const created = evts.find((e) => e.action === "created");
        if (created?.actor_kind === "salesperson" && created.salesperson_id === sp.id)
          pass("'created' event with actor_kind=salesperson");
        else fail("'created' event with actor_kind=salesperson", JSON.stringify(created ?? null));
        const stateEvt = evts.find((e) => e.action === "state" && e.actor_kind === "salesperson");
        if (stateEvt) pass("'state' transition recorded for salesperson", `→ ${stateEvt.to_state}`);
        else fail("'state' transition recorded for salesperson", `${evts.length} events`);
      }
    }

    // ---- 3. Team Leads list + card -----------------------------------------
    console.log("\n3 · Team Leads list + card");
    if (leadId) {
      const rows = lastRows(await send(dealerWaPhone, "menu_team_leads"));
      const hit = rows.find((r) => r.id === `tl:${leadId}`);
      if (hit) pass("list shows the team lead", hit.description ?? "");
      else fail("list shows the team lead", rows.map((r) => r.id).join(","));
      if (hit?.description?.includes("Verify"))
        pass("row names the salesperson");
      else fail("row names the salesperson", hit?.description ?? "no row");

      const cardSends = await send(dealerWaPhone, `tl:${leadId}`);
      const card = bodies(cardSends);
      const btns = cardSends.flatMap(
        (s) => (s as { buttons?: { id: string }[] }).buttons ?? [],
      );
      if (btns.some((b) => b.id === "tl_go") && btns.some((b) => b.id === "tl_hist"))
        pass("card offers Take over + History buttons");
      else fail("card offers Take over + History buttons", JSON.stringify(btns));
      if (card.includes("Verify Salesperson")) pass("card names the salesperson");
      else fail("card names the salesperson", card.slice(0, 120));
    }

    // ---- 4. Take over ------------------------------------------------------
    console.log("\n4 · Take over");
    if (leadId) {
      const sends = await send(dealerWaPhone, "tl_go");
      const text = bodies(sends);
      const st = (await sessionOf(dealerWaPhone))?.current_state;
      // Cash draft with no name yet → resumeDraft lands on the cash name step.
      if (text.includes("Resuming")) pass("resumeDraft ran in the dealer chat");
      else fail("resumeDraft ran in the dealer chat", text.slice(0, 160));
      if (st === "DC_CASH_NAME") pass("dealer chat is at the draft's next step", st);
      else fail("dealer chat is at the draft's next step", `state=${st}`);

      const evts = await eventsOf(leadId);
      const takeover = evts.find((e) => e.action === "takeover");
      if (takeover?.actor_kind === "dealer")
        pass("'takeover' event with actor_kind=dealer");
      else fail("'takeover' event with actor_kind=dealer", JSON.stringify(takeover ?? null));
    }

    // ---- 5. History --------------------------------------------------------
    console.log("\n5 · History");
    if (leadId) {
      await send(dealerWaPhone, "menu");
      const rows = lastRows(await send(dealerWaPhone, "menu_history"));
      if (rows.some((r) => r.id === `hl:${leadId}`)) pass("history picker lists the lead");
      else fail("history picker lists the lead", rows.map((r) => r.id).join(","));

      const text = bodies(await send(dealerWaPhone, `hl:${leadId}`));
      if (text.includes("Created by") && text.includes("Verify Salesperson"))
        pass("timeline shows creation by the salesperson");
      else fail("timeline shows creation by the salesperson", text.slice(0, 200));
      if (text.includes("took over")) pass("timeline shows the dealer takeover");
      else fail("timeline shows the dealer takeover", text.slice(0, 200));
    }

    // Leave the dealer chat at the menu.
    await send(dealerWaPhone, "menu");
  } finally {
    console.log("\nCleanup…");
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch (err) {
        console.error("  cleanup step failed:", err);
      }
    }
  }

  console.log(`\n${failed === 0 ? "ALL GREEN" : `${failed} FAILURE(S)`} — ${steps.length} assertions`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Top-level declarations collide with the sibling verify scripts under tsc's
// global-script scope; an export makes this file a module.
export {};
