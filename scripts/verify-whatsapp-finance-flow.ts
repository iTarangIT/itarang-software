/**
 * E-275 — drive the WhatsApp finance flow end to end against a real database.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-whatsapp-finance-flow.ts \
 *     <LEAD-ID> --i-understand-this-mutates
 *
 * Same harness as verify-whatsapp-journey.ts: `WA_DRY_RUN=1` swaps the Meta
 * adapter for one that records what it was asked to send, and `runTurn` is
 * driven with synthetic inbound events. Everything else — sessions, BRE,
 * product_selections, loan_sanctions — is real.
 *
 * THIS SCRIPT MUTATES. It sets `leads.requested_loan_amount`, submits Step 4
 * and (on the Bajaj path) sanctions the lead. Never point it at production.
 *
 * Covers:
 *   1. loan-amount question → single pick → disclosure → NBFC_RECEIVED_MSG
 *      (when the lead's area has ≥1 preferred partner), OR
 *   2. zero options → Bajaj card → Continue → sanctioned → startDispatch
 *      opened the battery picker in the same chat;
 *   3. the Next file / Done buttons on the Step-4 extra-docs bucket.
 *
 * Which of 1/2 runs depends on the lead's city — the script reports which.
 * Precondition for 1/2: finance lead at step_3_cleared / kyc_approved.
 */

process.env.WA_DRY_RUN = "1";

// Module scope — keeps this file's top-level names from colliding with the
// sibling verifier scripts, which are also plain scripts.
export {};

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
function skip(name: string, why: string) {
  console.log(`  ○ ${name} — skipped: ${why}`);
}

async function main() {
  const leadId = process.argv[2];
  const confirmed = process.argv.includes("--i-understand-this-mutates");
  if (!leadId || !confirmed) {
    console.error(
      "usage: verify-whatsapp-finance-flow.ts <LEAD-ID> --i-understand-this-mutates\n\n" +
        "This script WRITES: it sets the requested loan amount and submits Step 4.",
    );
    process.exit(2);
  }

  const { db } = await import("@/lib/db");
  const { eq, desc } = await import("drizzle-orm");
  const schema = await import("@/lib/db/schema");
  const { runTurn } = await import("@/lib/whatsapp/orchestrator");
  const { dryRunSends, dryRunClear } = await import("@/lib/whatsapp/dry-run");
  const { leadActionId } = await import("@/lib/whatsapp/leadActionButton");
  const { NBFC_RECEIVED_MSG, BAJAJ_FALLBACK } = await import("@/lib/leads/bajaj-fallback");
  const { DOC_DONE_ID, DOC_NEXT_ID } = await import("@/lib/whatsapp/doc-buttons");

  console.log("DB HOST:", new URL(process.env.DATABASE_URL ?? "http://none").hostname);
  console.log("LEAD   :", leadId, "\n");

  const [lead] = await db
    .select()
    .from(schema.leads)
    .where(eq(schema.leads.id, leadId))
    .limit(1);
  if (!lead) {
    console.error("Lead not found.");
    process.exit(1);
  }
  const waPhone = (lead.mobile || lead.phone || lead.owner_contact || "").replace(/\D/g, "");
  if (!waPhone) {
    console.error("Lead has no contact number — nothing to drive a chat from.");
    process.exit(1);
  }
  console.log(`payment_method: ${lead.payment_method}   kyc_status: ${lead.kyc_status}`);
  console.log(`requested_loan_amount: ${lead.requested_loan_amount ?? "(none)"}`);
  console.log(`chat number   : ${waPhone}\n`);

  let seq = 0;
  async function send(text: string, type: "interactive" | "text" = "interactive") {
    dryRunClear();
    seq += 1;
    await runTurn({
      providerMessageId: `verify-fin-${Date.now()}-${seq}`,
      waPhone,
      type,
      text,
      raw: { synthetic: true },
    });
    return dryRunSends();
  }
  function lastRows(sends: readonly { rows?: { id: string; title: string }[] }[]) {
    for (let i = sends.length - 1; i >= 0; i -= 1) {
      if (sends[i].rows?.length) return sends[i].rows!;
    }
    return [];
  }
  function bodies(sends: readonly { body: string }[]) {
    return sends.map((s) => s.body).join(" | ");
  }
  function buttonIds(sends: readonly { buttons?: { id: string }[] }[]) {
    return sends.flatMap((s) => (s.buttons ?? []).map((b) => b.id));
  }
  async function state(): Promise<string> {
    const [s] = await db
      .select({ current_state: schema.whatsappOnboardingSessions.current_state })
      .from(schema.whatsappOnboardingSessions)
      .where(eq(schema.whatsappOnboardingSessions.wa_phone, waPhone))
      .orderBy(desc(schema.whatsappOnboardingSessions.updated_at))
      .limit(1);
    return s?.current_state ?? "(no session)";
  }
  async function leadRow() {
    const [l] = await db
      .select({
        kyc_status: schema.leads.kyc_status,
        requested_loan_amount: schema.leads.requested_loan_amount,
      })
      .from(schema.leads)
      .where(eq(schema.leads.id, leadId))
      .limit(1);
    return l!;
  }

  // ---- Extra-docs buttons -------------------------------------------------
  console.log("Docs — Next file / Done buttons");
  {
    let sends = await send(leadActionId("xd_start", leadId));
    const st = await state();
    if (st === "DC_XD_WAIT") {
      const ids = buttonIds(sends);
      if (ids.includes(DOC_NEXT_ID) && ids.includes(DOC_DONE_ID)) {
        pass("bucket prompt carries Next file / Done", ids.join(","));
      } else {
        fail("bucket prompt carries Next file / Done", `buttons=${ids.join(",") || "(none)"}`);
      }
      sends = await send(DOC_NEXT_ID);
      if (/next file/i.test(bodies(sends)) && (await state()) === "DC_XD_WAIT") {
        pass("docs_next re-prompts for a file");
      } else {
        fail("docs_next re-prompts for a file", bodies(sends).slice(0, 160));
      }
      sends = await send(DOC_DONE_ID);
      const after = await state();
      if (after !== "DC_XD_WAIT") pass("docs_done ends the batch", `state=${after}`);
      else fail("docs_done ends the batch", `still ${after}: ${bodies(sends).slice(0, 160)}`);
      await send("menu");
    } else {
      skip("docs buttons", `xd_start landed on ${st} (bucket full or lead not eligible)`);
    }
  }

  // ---- Step 4 ---------------------------------------------------------------
  console.log("\nStep 4 — loan amount → one lender / Bajaj");
  const before = await leadRow();
  if (
    String(lead.payment_method).toLowerCase() !== "finance" ||
    !["step_3_cleared", "kyc_approved"].includes(before.kyc_status ?? "")
  ) {
    skip("Step 4", `lead is ${lead.payment_method}/${before.kyc_status}`);
  } else {
    // Force the amount question by clearing any stored amount.
    await db
      .update(schema.leads)
      .set({ requested_loan_amount: null })
      .where(eq(schema.leads.id, leadId));

    let sends = await send(leadActionId("s4_start", leadId));
    if ((await state()) === "DC_S4_AMT" && /how much loan/i.test(bodies(sends))) {
      pass("amount question asked", "state=DC_S4_AMT");
    } else {
      fail("amount question asked", `state=${await state()}: ${bodies(sends).slice(0, 160)}`);
    }

    sends = await send("banana", "text");
    if ((await state()) === "DC_S4_AMT") pass("garbage amount re-asks");
    else fail("garbage amount re-asks", `state=${await state()}`);

    sends = await send("1.5 lakh", "text");
    const stored = (await leadRow()).requested_loan_amount;
    if (stored === 150000) pass("amount parsed and stored", "1.5 lakh → 150000");
    else fail("amount parsed and stored", `requested_loan_amount=${stored}`);

    const st = await state();
    const rows = lastRows(sends);
    const ids = buttonIds(sends);

    if (st === "DC_S4_PICK" && rows.length > 0) {
      pass("lender list shown", `${rows.length} row(s)`);
      if (/second lending partner|Add a 2nd/i.test(bodies(sends))) {
        fail("single-lender copy", "second-lender wording still present");
      } else {
        pass("single-lender copy");
      }
      const leaked = sends.some((s) => /NBFC|Finance Ltd|Bajaj/i.test(s.body ?? ""));
      if (leaked) fail("lender masking", "a real lender name appeared");
      else pass("lender masking");

      sends = await send(rows[0].id);
      if ((await state()) === "DC_S4_ACK") pass("one pick → disclosure", "no second-lender step");
      else fail("one pick → disclosure", `state=${await state()}: ${bodies(sends).slice(0, 160)}`);

      sends = await send("s4_agree");
      const after = await leadRow();
      if (after.kyc_status === "pending_final_approval") pass("submitted", `kyc_status → ${after.kyc_status}`);
      else fail("submitted", `kyc_status=${after.kyc_status}: ${bodies(sends).slice(0, 200)}`);
      if (bodies(sends).includes(NBFC_RECEIVED_MSG)) pass("NBFC_RECEIVED_MSG in reply");
      else fail("NBFC_RECEIVED_MSG in reply", bodies(sends).slice(0, 200));
      if (/field visit|video KYC/i.test(bodies(sends))) fail("no FI/VKYC sentence", "still present");
      else pass("no FI/VKYC sentence");

      const assigns = await db
        .select({ nbfc_id: schema.nbfcLeadAssignments.nbfc_id })
        .from(schema.nbfcLeadAssignments)
        .where(eq(schema.nbfcLeadAssignments.lead_id, leadId));
      if (assigns.length === 1) pass("exactly one assignment", `nbfc ${assigns[0].nbfc_id}`);
      else fail("exactly one assignment", `${assigns.length} rows`);
    } else if (st === "DC_S4_BAJAJ") {
      pass("no partner → Bajaj card", `buttons=${ids.join(",")}`);
      if (!ids.includes("s4b_go") || !ids.includes("s4_redo")) {
        fail("Bajaj buttons", `expected s4b_go + s4_redo, got ${ids.join(",")}`);
      }
      if (/team will follow up/i.test(bodies(sends))) fail("dead-end copy removed", "still present");
      else pass("dead-end copy removed");

      sends = await send("s4b_go");
      if ((await state()) === "DC_S4_ACK" && bodies(sends).includes(BAJAJ_FALLBACK.name)) {
        pass("Bajaj → disclosure", `label ${BAJAJ_FALLBACK.name}`);
      } else {
        fail("Bajaj → disclosure", `state=${await state()}: ${bodies(sends).slice(0, 160)}`);
      }

      sends = await send("s4_agree");
      const after = await leadRow();
      if (after.kyc_status === "loan_sanctioned") pass("external submit sanctions", `kyc_status → ${after.kyc_status}`);
      else fail("external submit sanctions", `kyc_status=${after.kyc_status}: ${bodies(sends).slice(0, 200)}`);

      const [ls] = await db
        .select({ external_lender: schema.loanSanctions.external_lender })
        .from(schema.loanSanctions)
        .where(eq(schema.loanSanctions.lead_id, leadId))
        .orderBy(desc(schema.loanSanctions.created_at))
        .limit(1);
      if (ls?.external_lender === "bajaj_finance") pass("loan_sanctions.external_lender", ls.external_lender);
      else fail("loan_sanctions.external_lender", String(ls?.external_lender));

      const assigns = await db
        .select({ id: schema.nbfcLeadAssignments.id })
        .from(schema.nbfcLeadAssignments)
        .where(eq(schema.nbfcLeadAssignments.lead_id, leadId));
      if (assigns.length === 0) pass("no NBFC assignment on Bajaj path");
      else fail("no NBFC assignment on Bajaj path", `${assigns.length} rows`);

      if (/Application sent with Bajaj Finance/.test(bodies(sends))) pass("Bajaj sent message");
      else fail("Bajaj sent message", bodies(sends).slice(0, 200));

      const dpState = await state();
      const battRows = lastRows(sends).filter((r) => r.id.startsWith("dpb:"));
      if (dpState === "DC_DP_PRODUCT" || battRows.length > 0) {
        pass("startDispatch opened the picker in the same chat", `state=${dpState}, ${battRows.length} battery row(s)`);
      } else {
        fail("startDispatch opened the picker in the same chat", `state=${dpState}: ${bodies(sends).slice(-200)}`);
      }
    } else {
      fail("after amount", `unexpected state ${st}: ${bodies(sends).slice(0, 200)}`);
    }
  }

  console.log(`\n${steps.length - failed}/${steps.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
