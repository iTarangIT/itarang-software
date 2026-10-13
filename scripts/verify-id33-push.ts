/**
 * Verifier for tracker ID 33 — Push a house-dealer customer file to a dealer.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-id33-push.ts
 *
 * READ-ONLY. Selects only; nothing is written, no transaction is opened. Uses
 * the real readers the screens use (houseDealerCode, signedConsentLeadIds,
 * pushedBeforeLeadIds, pushBlockedReason, searchActiveDealers, pushHistory).
 *
 * Prints, for the most recent house-dealer customer files:
 *   • which would SHOW the "Push to dealer" button for a Sales Head / Admin;
 *   • which would be REFUSED because consent is signed (with the exact message);
 *   • coupon / salesperson a push would release / clear.
 * Then checks the dealer picker (approved + active, never the house, finance
 * filter) and that every recorded push row reads back with who/when/from/to.
 * Exit code 1 if a FAIL; a check SKIPs when the DB has nothing of that shape.
 */
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { auditLogs, dealers, leads } from "../src/lib/db/schema";
import { houseDealerCode, searchActiveDealers } from "../src/lib/leads/dealerByMobile";
import {
  dealerDisplayNames,
  LEAD_PUSHED_TO_DEALER,
  pushedBeforeLeadIds,
  pushHistory,
  signedConsentLeadIds,
} from "../src/lib/leads/pushGuards";
import { consentSignedMessage, couponOnPush, pushBlockedReason } from "../src/lib/leads/pushToDealer";

type Outcome = "PASS" | "FAIL" | "SKIP";
const results: Array<{ id: string; outcome: Outcome; note: string }> = [];

async function check(id: string, fn: () => Promise<string>) {
  try {
    results.push({ id, outcome: "PASS", note: await fn() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    results.push({ id, outcome: msg.startsWith("SKIP") ? "SKIP" : "FAIL", note: msg });
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const LIMIT = Number(process.env.ID33_LIMIT ?? 25);

async function main() {
  const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
  console.log(`DB host: ${host || "(unset)"}\n`);

  const house = await houseDealerCode();
  await check("house dealer resolves", async () => {
    assert(house, "no house dealer (dealer@itarang.com with a dealer_id) on this DB");
    return `house dealer = ${house}`;
  });
  if (!house) return finish();

  const rows = await db
    .select({
      id: leads.id,
      name: leads.owner_name,
      channel: leads.source_channel,
      payment: leads.payment_method,
      consent: leads.consent_status,
      coupon: leads.coupon_code,
      couponStatus: leads.coupon_status,
      salesperson: leads.salesperson_id,
      updatedAt: leads.updated_at,
    })
    .from(leads)
    .where(and(eq(leads.dealer_id, house), sql`${leads.deleted_by_dealer_at} IS NULL`))
    .orderBy(desc(leads.updated_at))
    .limit(LIMIT);

  const ids = rows.map((r) => r.id);
  const [signed, pushed, names] = await Promise.all([
    signedConsentLeadIds(ids),
    pushedBeforeLeadIds(ids),
    dealerDisplayNames([house]),
  ]);
  const houseName = names.get(house) ?? house;

  console.log(`Latest ${rows.length} house-dealer files (as Sales Head):`);
  let shown = 0;
  let refusedConsent = 0;
  for (const r of rows) {
    const blocked = pushBlockedReason({
      actorRole: "sales_head",
      currentDealerId: house,
      currentDealerName: houseName,
      houseDealerCode: house,
      consentSigned: signed.has(r.id),
      pushedBefore: pushed.has(r.id),
    });
    if (!blocked) shown++;
    if (signed.has(r.id)) refusedConsent++;
    const extras = [
      couponOnPush(r.coupon, r.couponStatus) === "release" ? `coupon ${r.coupon} -> released` : null,
      couponOnPush(r.coupon, r.couponStatus) === "keep_used" ? `coupon ${r.coupon} used (kept)` : null,
      r.salesperson ? "salesperson -> cleared" : null,
    ].filter(Boolean);
    console.log(
      `  ${blocked ? "REFUSE" : "BUTTON"}  ${r.id}  ${(r.name ?? "").slice(0, 24).padEnd(24)} ` +
        `${(r.channel ?? "web").padEnd(8)} ${(r.payment ?? "-").padEnd(13)} consent=${r.consent ?? "-"}` +
        (blocked ? `  [${blocked.message}]` : "") +
        (extras.length ? `  (${extras.join(", ")})` : ""),
    );
  }
  console.log("");

  await check("button shown only before consent", async () => {
    if (!rows.length) throw new Error("SKIP no house-dealer files on this DB");
    for (const r of rows) {
      const blocked = pushBlockedReason({
        actorRole: "sales_head",
        currentDealerId: house,
        currentDealerName: houseName,
        houseDealerCode: house,
        consentSigned: signed.has(r.id),
        pushedBefore: pushed.has(r.id),
      });
      if (signed.has(r.id)) {
        assert(blocked?.message === consentSignedMessage(houseName), `${r.id}: consent signed but not refused with the agreed message`);
      }
    }
    return `${shown} of ${rows.length} would show the button; ${refusedConsent} refused (consent signed)`;
  });

  await check("other roles never see it", async () => {
    // The GET and list gates admit admin + sales_head only (PUSH_TO_DEALER_INTERNAL_ROLES).
    const { PUSH_TO_DEALER_INTERNAL_ROLES } = await import("../src/lib/leads/pushToDealer");
    assert(
      [...PUSH_TO_DEALER_INTERNAL_ROLES].sort().join(",") === "admin,sales_head",
      `roles are ${PUSH_TO_DEALER_INTERNAL_ROLES.join(",")}`,
    );
    return "admin, sales_head";
  });

  await check("dealer picker: approved + active, never the house, finance filter", async () => {
    const [any] = await db
      .select({ name: dealers.company_name })
      .from(dealers)
      .where(eq(dealers.onboarding_status, "active"))
      .limit(1);
    if (!any) throw new Error("SKIP no active dealer on this DB");
    const probe = (any.name ?? "").slice(0, 3);
    const all = await searchActiveDealers(probe, 20);
    const fin = await searchActiveDealers(probe, 20, { financeOnly: true });
    assert(all.every((d) => d.dealerId !== house), "house dealer offered as a target");
    assert(fin.every((d) => d.financeEnabled), "finance-only search returned a cash-only dealer");
    if (all.length) {
      const st = await db
        .select({ id: dealers.dealer_id, s: dealers.onboarding_status })
        .from(dealers)
        .where(sql`${dealers.dealer_id} IN (${sql.join(all.map((d) => sql`${d.dealerId}`), sql`, `)})`);
      assert(st.every((r) => r.s === "active"), "a non-active dealer was offered");
    }
    return `"${probe}": ${all.length} offered, ${fin.length} finance-enabled`;
  });

  await check("push history reads back who / when / from / to", async () => {
    const recent = await db
      .select({ leadId: auditLogs.entity_id })
      .from(auditLogs)
      .where(and(eq(auditLogs.entity_type, "lead"), eq(auditLogs.action, LEAD_PUSHED_TO_DEALER)))
      .orderBy(desc(auditLogs.timestamp))
      .limit(5);
    if (!recent.length) throw new Error("SKIP no push recorded yet on this DB");
    const lines: string[] = [];
    for (const { leadId } of recent) {
      const h = await pushHistory(leadId!);
      assert(h.length > 0, `${leadId}: audit row not read back`);
      const last = h[h.length - 1];
      assert(last.at && last.toDealerId, `${leadId}: missing when/to`);
      lines.push(
        `${leadId}: ${last.fromDealerName ?? "?"} -> ${last.toDealerName ?? "?"} by ${last.byName ?? last.byUserId ?? "?"}` +
          `${last.reason ? "" : " (no reason - older path)"}`,
      );
    }
    return lines.join("; ");
  });

  await check("one push per file: no pushed file is still offered to a sales head", async () => {
    const offered = rows.filter((r) => pushed.has(r.id)).filter(
      (r) =>
        pushBlockedReason({
          actorRole: "sales_head",
          currentDealerId: house,
          houseDealerCode: house,
          consentSigned: signed.has(r.id),
          pushedBefore: true,
        }) === null,
    );
    assert(offered.length === 0, `${offered.length} pushed files still offered`);
    return `${rows.filter((r) => pushed.has(r.id)).length} pushed file(s) back with the house: admin-only`;
  });

  finish();
}

function finish() {
  for (const r of results) console.log(`${r.outcome.padEnd(4)}  ${r.id} — ${r.note}`);
  const failed = results.filter((r) => r.outcome === "FAIL").length;
  console.log(`\n${results.length - failed} ok / ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
