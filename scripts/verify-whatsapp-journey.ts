/**
 * Drive the WhatsApp customer journey end to end against a real database.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-whatsapp-journey.ts \
 *     <LEAD-ID> --i-understand-this-mutates
 *
 * WHY THIS EXISTS. The journey is a state machine whose transitions are inbound
 * messages and whose output is outbound messages. The only honest way to verify
 * it is to drive `runTurn` for real — real sessions, real services, real writes —
 * with the single leg that talks to Meta stubbed out. That is what
 * `WA_DRY_RUN=1` gives us (src/lib/whatsapp/dry-run.ts), and it is set here
 * BEFORE the orchestrator is imported, because `getAdapter()` caches.
 *
 * THIS SCRIPT MUTATES. It is not one of the read-only `_verify-*` probes. It
 * sends the lead through Step 4, the offer thread and dispatch, and a completed
 * run leaves the lead DISPATCHED with stock consumed. Hence the explicit flag —
 * never point it at production.
 *
 * WHAT IT DOES NOT COVER. The KYC document legs (Steps 1–3): they need real
 * media and a real Gemini call, so a stub would prove nothing. Those stay on the
 * live checklist. Everything from "send to lenders" onwards is covered here.
 *
 * WHAT PHASE 4 NOW ASSERTS. The chat collects the product choice and hands over
 * to the team — it does NOT send a delivery code and does NOT dispatch. So the
 * checks are inverted from what you might expect: a minted `otp_confirmations`
 * row or a lead that moved past `loan_sanctioned` is a FAILURE here.
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
function skip(name: string, why: string) {
  console.log(`  ○ ${name} — skipped: ${why}`);
}

async function main() {
  const leadId = process.argv[2];
  const confirmed = process.argv.includes("--i-understand-this-mutates");
  if (!leadId || !confirmed) {
    console.error(
      "usage: verify-whatsapp-journey.ts <LEAD-ID> --i-understand-this-mutates\n\n" +
        "This script WRITES: it walks the lead through Step 4, offers and dispatch.\n" +
        "A completed run leaves the lead dispatched and stock consumed.",
    );
    process.exit(2);
  }

  const { db } = await import("@/lib/db");
  const { eq, desc, and } = await import("drizzle-orm");
  const schema = await import("@/lib/db/schema");
  const { runTurn } = await import("@/lib/whatsapp/orchestrator");
  const { dryRunSends, dryRunClear } = await import("@/lib/whatsapp/dry-run");
  const { leadActionId } = await import("@/lib/whatsapp/leadActionButton");

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
  console.log(`chat number   : ${waPhone}\n`);

  let seq = 0;
  /** One inbound message, through the real routing spine. */
  async function send(text: string) {
    dryRunClear();
    seq += 1;
    await runTurn({
      providerMessageId: `verify-${Date.now()}-${seq}`,
      waPhone,
      type: "interactive",
      text,
      raw: { synthetic: true },
    });
    return dryRunSends();
  }

  /** The rows of the most recent interactive list we were sent. */
  function lastRows(sends: readonly { rows?: { id: string; title: string }[] }[]) {
    for (let i = sends.length - 1; i >= 0; i -= 1) {
      if (sends[i].rows?.length) return sends[i].rows!;
    }
    return [];
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
  async function kycStatus(): Promise<string> {
    const [l] = await db
      .select({ kyc_status: schema.leads.kyc_status })
      .from(schema.leads)
      .where(eq(schema.leads.id, leadId))
      .limit(1);
    return l?.kyc_status ?? "";
  }

  // ---- Phase 2: Step 4, routing to lenders -------------------------------
  console.log("Phase 2 — Step 4 (lenders)");
  if (["step_3_cleared", "kyc_approved"].includes(await kycStatus())) {
    let sends = await send(leadActionId("s4_start", leadId));
    let rows = lastRows(sends);
    if (rows.length === 0) {
      fail("s4_start", `no lender list — ${sends.map((s) => s.body).join(" / ").slice(0, 160)}`);
    } else {
      pass("s4_start", `${rows.length} scheme row(s), state ${await state()}`);
      const leaked = sends.some((s) => /NBFC|Finance Ltd|Bajaj/i.test(s.body ?? ""));
      if (leaked) fail("lender masking", "a real lender name appeared in the chat");
      else pass("lender masking", "only 'iTarang Scheme N' shown");

      sends = await send(rows[0].id);
      // A second lender is optional; take it if offered, else fall through.
      rows = lastRows(sends);
      const second = rows.find((r) => r.id.startsWith("s4p:"));
      if (second) sends = await send(second.id);
      // Whatever we are on now, agree.
      sends = await send("s4_agree");
      const after = await kycStatus();
      if (after === "pending_final_approval") pass("s4_agree", `kyc_status → ${after}`);
      else fail("s4_agree", `expected pending_final_approval, got ${after}`);

      const assigns = await db
        .select({ nbfc_id: schema.nbfcLeadAssignments.nbfc_id })
        .from(schema.nbfcLeadAssignments)
        .where(eq(schema.nbfcLeadAssignments.lead_id, leadId));
      if (assigns.length > 0) pass("Acquire fan-out", `${assigns.length} nbfc_lead_assignments`);
      else fail("Acquire fan-out", "no nbfc_lead_assignments rows written");
    }
  } else {
    skip("Step 4", `lead is ${await kycStatus()}, not step_3_cleared/kyc_approved`);
  }

  // ---- Phase 3: offers, negotiation --------------------------------------
  console.log("\nPhase 3 — offers & negotiation");
  const { listLeadOffers, actionableOffers } = await import("@/lib/leads/offers");
  const view = await listLeadOffers(leadId);
  const live = actionableOffers(view);

  if (view.winnerNbfcId != null) {
    // Already decided — a re-run against the same lead. Not a failure: the chat
    // correctly refuses to re-open a closed choice, which is what we want.
    skip("offers", `a lender was already chosen (nbfc ${view.winnerNbfcId})`);
  } else if (live.length === 0) {
    skip(
      "offers",
      view.items.length === 0
        ? "no lenders routed yet"
        : "no lender has submitted a released offer (have an NBFC submit one, then re-run)",
    );
  } else {
    const { pushOfferToWhatsApp } = await import("@/lib/whatsapp/offer-flow");
    await pushOfferToWhatsApp(leadId, live[0].nbfc_id);
    pass("offer push", `pushed offer from nbfc ${live[0].nbfc_id}`);

    let sends = await send(leadActionId("of_view", leadId));
    let rows = lastRows(sends);
    const askRow = rows.find((r) => r.id.startsWith("ofa:"));
    const pickRow = rows.find((r) => r.id.startsWith("ofp:"));
    if (!pickRow) {
      fail("of_view", `no accept row rendered — state ${await state()}`);
    } else {
      pass("of_view", `${rows.length} row(s), state ${await state()}`);

      if (askRow) {
        await send(askRow.id);
        const before = await db
          .select({ id: schema.nbfcOfferNegotiations.id })
          .from(schema.nbfcOfferNegotiations)
          .where(eq(schema.nbfcOfferNegotiations.lead_id, leadId));
        await send("Can you reduce the EMI a little? [verify-whatsapp-journey]");
        const after = await db
          .select({
            id: schema.nbfcOfferNegotiations.id,
            party: schema.nbfcOfferNegotiations.party,
            message: schema.nbfcOfferNegotiations.message,
          })
          .from(schema.nbfcOfferNegotiations)
          .where(eq(schema.nbfcOfferNegotiations.lead_id, leadId))
          .orderBy(desc(schema.nbfcOfferNegotiations.round));
        if (after.length > before.length) {
          const newest = after[0];
          pass("negotiation round", `party='${newest.party}', "${(newest.message ?? "").slice(0, 40)}…"`);
          if (newest.party !== "customer" && newest.party !== "dealer") {
            fail("negotiation party", `unexpected party '${newest.party}'`);
          }
        } else {
          fail("negotiation round", "no nbfc_offer_negotiations row appended");
        }
      } else {
        skip("negotiation", "offer is fixed — 'ask for better' correctly hidden");
      }

      // Accept. Re-render first: the negotiation moved us to DC_OF_WAIT.
      sends = await send(leadActionId("of_view", leadId));
      rows = lastRows(sends);
      const accept = rows.find((r) => r.id.startsWith("ofp:")) ?? pickRow;
      await send(accept.id);
      const status = await kycStatus();
      if (status === "awaiting_enach") pass("accept offer", `kyc_status → ${status}`);
      else fail("accept offer", `expected awaiting_enach, got ${status}`);
    }
  }

  // ---- Phase 4: Step 5, cart + dispatch -----------------------------------
  console.log("\nPhase 4 — Step 5 (cart, then hand off)");
  if ((await kycStatus()) !== "loan_sanctioned") {
    skip(
      "dispatch",
      `lead is ${await kycStatus()} — have the NBFC sanction it (POST /api/nbfc/sanction/${leadId}), then re-run`,
    );
  } else {
    // Counted BEFORE the phase, not compared against zero: a lead that was
    // driven through the old code-based flow already carries rows, and this
    // check is about what THIS run mints.
    const otpsBefore = (
      await db
        .select({ id: schema.otpConfirmations.id })
        .from(schema.otpConfirmations)
        .where(
          and(
            eq(schema.otpConfirmations.lead_id, leadId),
            eq(schema.otpConfirmations.otp_type, "dispatch_confirmation"),
          ),
        )
    ).length;

    let sends = await send(leadActionId("dp_start", leadId));
    let rows = lastRows(sends);
    const batteryRow = rows.find((r) => r.id.startsWith("dpb:"));
    if (!batteryRow) {
      fail("dp_start", `no battery list — ${sends.map((s) => s.body).join(" / ").slice(0, 200)}`);
    } else {
      pass("dp_start", `${rows.length} stock row(s), state ${await state()}`);

      sends = await send(batteryRow.id);
      rows = lastRows(sends);
      const chargerRow = rows.find((r) => r.id.startsWith("dpc:") || r.id === "dpc_skip");
      if (chargerRow) {
        sends = await send(chargerRow.id);
        pass("charger step", chargerRow.id === "dpc_skip" ? "skipped" : "charger added");
      }

      const [sel] = await db
        .select({
          battery_serial: schema.productSelections.battery_serial,
          final_price: schema.productSelections.final_price,
        })
        .from(schema.productSelections)
        .where(eq(schema.productSelections.lead_id, leadId))
        .orderBy(desc(schema.productSelections.created_at))
        .limit(1);
      if (sel?.battery_serial) {
        pass("cart saved", `serial ${sel.battery_serial}, total ${sel.final_price}`);
      } else {
        fail("cart saved", "product_selections.battery_serial is still null");
      }

      // The chat hands over here — it must NOT send a delivery code and must
      // NOT dispatch. The dealer runs the OTP and Confirm Dispatch on Step 5.
      const handoff = sends.some((s) =>
        (s.body ?? "").includes("iTarang Team will connect you"),
      );
      if (handoff) pass("handoff message", "sent with the order summary");
      else
        fail(
          "handoff message",
          `not sent — last body: ${(sends[sends.length - 1]?.body ?? "").slice(0, 120)}`,
        );

      const parked = await state();
      if (parked === "DC_DP_WAIT") pass("parked", "state DC_DP_WAIT");
      else fail("parked", `state is ${parked}, expected DC_DP_WAIT`);

      // The specific regression this change is about: no code was minted.
      const otps = await db
        .select({ id: schema.otpConfirmations.id })
        .from(schema.otpConfirmations)
        .where(
          and(
            eq(schema.otpConfirmations.lead_id, leadId),
            eq(schema.otpConfirmations.otp_type, "dispatch_confirmation"),
          ),
        );
      const minted = otps.length - otpsBefore;
      if (minted === 0) {
        pass(
          "no delivery code",
          otpsBefore > 0
            ? `no new otp_confirmations row (${otpsBefore} pre-existing, from before this change)`
            : "no otp_confirmations row created",
        );
      } else {
        fail("no delivery code", `${minted} otp_confirmations row(s) minted by this run`);
      }

      const stillSanctioned = await kycStatus();
      if (stillSanctioned === "loan_sanctioned") {
        pass("dispatch left to dealer", "kyc_status still loan_sanctioned");
      } else {
        fail(
          "dispatch left to dealer",
          `kyc_status moved to ${stillSanctioned} — the chat should not dispatch`,
        );
      }
    }
  }

  console.log(
    `\n${steps.filter((s) => s.ok).length} passed, ${failed} failed, ` +
      `${steps.length} checked.`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
