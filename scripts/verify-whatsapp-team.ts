/**
 * E-277 — drive the dealer sales-team feature end to end against a real DB.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-whatsapp-team.ts \
 *     <DEALER-WA-PHONE> --i-understand-this-mutates
 *
 * <DEALER-WA-PHONE> is an APPROVED dealer's WhatsApp number (digits, e.g.
 * 919876543210) — the same number that opens their dealer console.
 *
 * Same harness as verify-whatsapp-journey.ts: WA_DRY_RUN=1 swaps the Meta
 * adapter for the capture stub, set BEFORE the orchestrator import because
 * getAdapter() caches. THIS SCRIPT MUTATES: it adds/removes a synthetic
 * salesperson on the dealer's team, drives their chat, and creates one
 * customer lead attributed to them. Best-effort cleanup at the end deletes
 * what it created — never point it at production.
 *
 * What it asserts:
 *   1. Dealer menu shows My Team; add flow (phone → name → confirm) inserts a
 *      dealer_salespersons row; double-add and dealer-own-number are rejected.
 *   2. Salesperson's first "hi" opens the console (restricted menu), mints a
 *      session_kind='salesperson' row and NO draft dealer application.
 *   3. A lead created from the salesperson chat carries salesperson_id,
 *      the dealer's uploader_id and dealer_id.
 *   4. Draft scoping: the salesperson's list shows only their lead; the
 *      dealer-scope list shows it too.
 *   5. resolveLeadTarget prefers the salesperson chat; after deactivation it
 *      falls back to the dealer channel.
 *   6. Removal: one "access removed" notice, session downgraded, next "hi"
 *      goes to onboarding (a fresh prospect).
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
      "usage: verify-whatsapp-team.ts <DEALER-WA-PHONE> --i-understand-this-mutates\n\n" +
        "This script WRITES: it adds/removes a synthetic salesperson and creates one lead.",
    );
    process.exit(2);
  }

  const { db } = await import("@/lib/db");
  const { and, desc, eq } = await import("drizzle-orm");
  const schema = await import("@/lib/db/schema");
  const { runTurn } = await import("@/lib/whatsapp/orchestrator");
  const { dryRunSends, dryRunClear } = await import("@/lib/whatsapp/dry-run");
  const { resolveWhatsAppDealer } = await import("@/lib/whatsapp/dealer-identity");
  const { resolveSalesperson } = await import("@/lib/whatsapp/salesperson-identity");
  const { listDealerDrafts } = await import("@/lib/whatsapp/customer-lead");
  const { addSalesperson, deactivateSalesperson } = await import("@/lib/team/salespersons");
  const { resolveLeadTarget } = await import("@/lib/whatsapp/lead-push");

  console.log("DB HOST:", new URL(process.env.DATABASE_URL ?? "http://none").hostname);

  const dealer = await resolveWhatsAppDealer(dealerWaPhone);
  if (!dealer?.dealerCode || !dealer.dealerUserId) {
    console.error("That number does not resolve to an approved/active dealer.");
    process.exit(1);
  }
  console.log(`DEALER : ${dealer.dealerCode} (${dealer.dealerName ?? "?"})\n`);

  // Synthetic salesperson number — 91 + 93xxxxxxxx, random tail so re-runs
  // never collide with a live number or a previous run's leftovers.
  const spPhone = `9193${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const custMobile = `98${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  console.log(`SP     : ${spPhone}\nCUST   : ${custMobile}\n`);

  let seq = 0;
  // Free text must go in as type "text" — several handlers (onLeadMobile) only
  // accept typed input from a text event; button/row ids go in as "interactive".
  async function send(
    fromPhone: string,
    text: string,
    type: "interactive" | "text" = "interactive",
  ) {
    dryRunClear();
    seq += 1;
    await runTurn({
      providerMessageId: `verify-team-${Date.now()}-${seq}`,
      waPhone: fromPhone,
      type,
      text,
      raw: { synthetic: true },
    } as Parameters<typeof runTurn>[0]);
    return dryRunSends();
  }
  function lastRows(sends: readonly { rows?: { id: string; title: string }[] }[]) {
    for (let i = sends.length - 1; i >= 0; i -= 1) {
      if (sends[i].rows?.length) return sends[i].rows!;
    }
    return [];
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

  const cleanup: Array<() => Promise<void>> = [];

  // The drive mutates the DEALER's real session (state, parked ctx). Snapshot
  // it up front and restore it at the end so their chat resumes untouched.
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
    // ---- 1. Dealer adds a salesperson over WhatsApp -----------------------
    console.log("1 · Dealer 'My Team' add flow");
    {
      let sends = await send(dealerWaPhone, "menu");
      const rows = lastRows(sends);
      if (rows.some((r) => r.id === "menu_team")) pass("dealer menu shows My Team");
      else fail("dealer menu shows My Team", `rows=${rows.map((r) => r.id).join(",")}`);

      await send(dealerWaPhone, "menu_team");
      await send(dealerWaPhone, "team_add");
      await send(dealerWaPhone, spPhone, "text");
      await send(dealerWaPhone, "Verify Salesperson", "text");
      sends = await send(dealerWaPhone, "team_yes");

      const sp = await resolveSalesperson(spPhone);
      if (sp && sp.dealerCode === dealer.dealerCode) {
        pass("dealer_salespersons row created", sp.id);
      } else {
        fail("dealer_salespersons row created", "resolveSalesperson returned null");
      }

      // Conflict tests only make sense once the row exists — running them
      // without it would itself INSERT the salesperson.
      if (sp) {
        const dup = await addSalesperson({
          dealerCode: dealer.dealerCode,
          phone: spPhone,
          displayName: "Duplicate",
          addedBy: null,
          addedVia: "admin",
        });
        if (!dup.ok && dup.reason === "already_salesperson_here")
          pass("double-add rejected", dup.reason);
        else fail("double-add rejected", JSON.stringify(dup));

        const own = await addSalesperson({
          dealerCode: dealer.dealerCode,
          phone: dealerWaPhone,
          displayName: "Self",
          addedBy: null,
          addedVia: "admin",
        });
        if (!own.ok && (own.reason === "is_dealer" || own.reason === "is_own_number"))
          pass("dealer's own number rejected", own.reason);
        else fail("dealer's own number rejected", JSON.stringify(own));
      }

      // Leave the dealer chat back at the main menu.
      await send(dealerWaPhone, "menu");
    }

    const sp = await resolveSalesperson(spPhone);
    if (!sp) throw new Error("salesperson row missing — cannot continue");
    cleanup.push(async () => {
      await db
        .delete(schema.dealerSalespersons)
        .where(eq(schema.dealerSalespersons.wa_phone, spPhone));
    });

    // ---- 2. Salesperson's first "hi" --------------------------------------
    console.log("\n2 · Salesperson first contact");
    {
      const appsBefore = await db
        .select({ id: schema.dealerOnboardingApplications.id })
        .from(schema.dealerOnboardingApplications)
        .where(eq(schema.dealerOnboardingApplications.wa_phone, spPhone));

      const sends = await send(spPhone, "hi");
      const sess = await sessionOf(spPhone);
      if (sess?.session_kind === "salesperson" && sess.salesperson_id === sp.id)
        pass("session_kind='salesperson'", sess.id);
      else fail("session_kind='salesperson'", `kind=${sess?.session_kind}`);
      cleanup.push(async () => {
        // whatsapp_messages FKs the session — delete the log rows first.
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

      const appsAfter = await db
        .select({ id: schema.dealerOnboardingApplications.id })
        .from(schema.dealerOnboardingApplications)
        .where(eq(schema.dealerOnboardingApplications.wa_phone, spPhone));
      if (appsAfter.length === appsBefore.length)
        pass("no draft application minted");
      else fail("no draft application minted", `${appsAfter.length - appsBefore.length} new row(s)`);

      const rows = lastRows(sends);
      const ids = rows.map((r) => r.id);
      if (
        ids.includes("menu_new_lead") &&
        !ids.includes("menu_team") &&
        !ids.includes("menu_inventory")
      )
        pass("restricted menu (no Team/Inventory)", ids.join(","));
      else fail("restricted menu (no Team/Inventory)", ids.join(","));
    }

    // ---- 3. Salesperson creates a lead ------------------------------------
    console.log("\n3 · Lead attribution");
    let leadId: string | null = null;
    {
      for (const msg of ["menu_new_lead", custMobile, "interest_hot", "pay_cash"]) {
        const sends = await send(spPhone, msg, msg === custMobile ? "text" : "interactive");
        const st = (await sessionOf(spPhone))?.current_state;
        console.log(
          `    → "${msg}" · state=${st} · last="${String(
            (sends[sends.length - 1] as { body?: string })?.body ?? "",
          ).slice(0, 70)}"`,
        );
      }

      const [lead] = await db
        .select({
          id: schema.leads.id,
          salesperson_id: schema.leads.salesperson_id,
          uploader_id: schema.leads.uploader_id,
          dealer_id: schema.leads.dealer_id,
        })
        .from(schema.leads)
        .where(eq(schema.leads.mobile, `+91${custMobile.slice(-10)}`))
        .orderBy(desc(schema.leads.created_at))
        .limit(1);

      if (lead) {
        leadId = lead.id;
        cleanup.push(async () => {
          await db.delete(schema.personalDetails).where(eq(schema.personalDetails.lead_id, lead.id));
          await db.delete(schema.leads).where(eq(schema.leads.id, lead.id));
        });
        if (lead.salesperson_id === sp.id) pass("leads.salesperson_id stamped", lead.id);
        else fail("leads.salesperson_id stamped", `got ${lead.salesperson_id}`);
        if (lead.uploader_id === dealer.dealerUserId) pass("uploader_id = dealer's user");
        else fail("uploader_id = dealer's user", `got ${lead.uploader_id}`);
        if (lead.dealer_id === dealer.dealerCode) pass("dealer_id = dealer code");
        else fail("dealer_id = dealer code", `got ${lead.dealer_id}`);
      } else {
        fail("lead created from salesperson chat", "no leads row for the customer mobile");
      }
    }

    // ---- 4. Draft scoping --------------------------------------------------
    console.log("\n4 · Draft scoping");
    if (leadId) {
      const spDrafts = await listDealerDrafts(dealer.dealerCode, 10, sp.id);
      if (spDrafts.some((d) => d.leadId === leadId))
        pass("salesperson list contains own lead");
      else fail("salesperson list contains own lead", `${spDrafts.length} drafts, none match`);

      const dealerDrafts = await listDealerDrafts(dealer.dealerCode, 10);
      if (dealerDrafts.some((d) => d.leadId === leadId))
        pass("dealer list contains the team lead");
      else fail("dealer list contains the team lead", `${dealerDrafts.length} drafts, none match`);
    }

    // ---- 5. Push routing ---------------------------------------------------
    console.log("\n5 · Push routing");
    if (leadId) {
      const target = await resolveLeadTarget(leadId);
      if (target?.session?.wa_phone === spPhone && target.viaSalesperson)
        pass("resolveLeadTarget prefers salesperson chat");
      else
        fail(
          "resolveLeadTarget prefers salesperson chat",
          `session=${target?.session?.wa_phone}, via=${target?.viaSalesperson}`,
        );
    }

    // ---- 6. Removal --------------------------------------------------------
    console.log("\n6 · Removal");
    {
      const removed = await deactivateSalesperson({
        dealerCode: dealer.dealerCode,
        salespersonId: sp.id,
        deactivatedBy: null,
      });
      if (removed && !removed.isActive) pass("deactivated");
      else fail("deactivated", JSON.stringify(removed));

      if (leadId) {
        const target = await resolveLeadTarget(leadId);
        if (target && target.session?.wa_phone !== spPhone)
          pass("push falls back off the removed salesperson", `→ ${target.session?.wa_phone ?? "cold"}`);
        else fail("push falls back off the removed salesperson", `still ${target?.session?.wa_phone}`);
      }

      const sends = await send(spPhone, "hi");
      const sess = await sessionOf(spPhone);
      const noticed = sends.some((s) =>
        String((s as { body?: string }).body ?? "").toLowerCase().includes("removed"),
      );
      if (noticed) pass("one 'access removed' notice sent");
      else fail("one 'access removed' notice sent", `${sends.length} sends`);
      if (sess?.session_kind === "dealer" && sess.salesperson_id === null)
        pass("session downgraded", `state=${sess.current_state}`);
      else fail("session downgraded", `kind=${sess?.session_kind}`);

      const next = await send(spPhone, "hi");
      const consoleMenu = lastRows(next).some((r) => r.id === "menu_new_lead");
      if (!consoleMenu) pass("next 'hi' is a fresh prospect (no console)");
      else fail("next 'hi' is a fresh prospect (no console)", "console menu rendered");
    }
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

// Top-level declarations (Step/steps/failed) collide with the sibling verify
// scripts under tsc's global-script scope; an export makes this file a module.
export {};
