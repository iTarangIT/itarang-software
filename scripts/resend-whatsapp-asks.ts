// Re-deliver everything a lead is currently BEING ASKED FOR to WhatsApp:
// open document requests, and an outstanding co-borrower request.
//
// Two reasons this exists rather than being a one-off:
//
//   1. Requests created before E-264 were never delivered at all — the admin
//      route minted an upload link and nothing sent it. Those rows are sitting
//      in `other_document_requests` with upload_status='not_uploaded' and a
//      customer who was never told.
//   2. "Resend the request" is a real operational need. The customer deleted the
//      chat, changed phones, or the 24-hour window shut before an approved
//      template existed.
//
// It creates NO new rows and mints NO new tokens — it re-sends the links that
// already exist, so the admin screen and the customer see the same request.
//
//   node --import tsx --env-file=.env.local scripts/resend-whatsapp-asks.ts <LEAD-ID> --dry-run
//   node --import tsx --env-file=.env.local scripts/resend-whatsapp-asks.ts <LEAD-ID>

import { and, eq, isNull, or } from "drizzle-orm";

import { db } from "../src/lib/db";
import {
  coBorrowerRequests,
  coBorrowers,
  leads,
  otherDocumentRequests,
} from "../src/lib/db/schema";

const leadId = process.argv[2];
const DRY_RUN = process.argv.includes("--dry-run");
if (!leadId || leadId.startsWith("--")) {
  throw new Error("usage: … resend-whatsapp-asks.ts <LEAD-ID> [--dry-run]");
}

async function main() {
  const [lead] = await db
    .select({
      id: leads.id,
      reference_id: leads.reference_id,
      source_channel: leads.source_channel,
      mobile: leads.mobile,
      phone: leads.phone,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  if (!lead) {
    console.log(`Lead ${leadId} not found.`);
    return;
  }

  console.log("LEAD          :", lead.id, `(${lead.reference_id ?? "no ref"})`);
  console.log("source_channel:", lead.source_channel ?? "(null)");
  console.log("customer phone:", lead.mobile ?? lead.phone ?? "(none)");

  // --- Co-borrower ------------------------------------------------------
  // Outstanding when the lead carries the flag AND the co-borrower has not been
  // handed back yet. verification_submitted_at is the same column the admin
  // screen gates its "awaiting dealer submission" banner on, so this asks
  // exactly when that banner is showing.
  const [cbReq] = await db
    .select({ id: coBorrowerRequests.id, reason: coBorrowerRequests.reason })
    .from(coBorrowerRequests)
    .where(
      and(
        eq(coBorrowerRequests.lead_id, leadId),
        eq(coBorrowerRequests.status, "open"),
      ),
    )
    .limit(1);
  const [cbRow] = await db
    .select({ submitted: coBorrowers.verification_submitted_at })
    .from(coBorrowers)
    .where(eq(coBorrowers.lead_id, leadId))
    .limit(1);

  const coBorrowerPending = Boolean(cbReq) && !cbRow?.submitted;
  if (coBorrowerPending) {
    console.log(`\nCo-borrower request OPEN${cbReq?.reason ? ` — ${cbReq.reason}` : ""}`);
    if (!DRY_RUN) {
      const { pushCoBorrowerRequest } = await import(
        "../src/lib/whatsapp/coborrower-flow"
      );
      await pushCoBorrowerRequest(leadId, cbReq?.reason ?? null);
      console.log("  -> pushed to WhatsApp.");
    }
  }

  // --- Documents --------------------------------------------------------
  const open = await db
    .select({
      id: otherDocumentRequests.id,
      doc_label: otherDocumentRequests.doc_label,
      doc_for: otherDocumentRequests.doc_for,
      reason: otherDocumentRequests.rejection_reason,
      token: otherDocumentRequests.upload_token,
      expires: otherDocumentRequests.token_expires_at,
    })
    .from(otherDocumentRequests)
    .where(
      and(
        eq(otherDocumentRequests.lead_id, leadId),
        or(
          eq(otherDocumentRequests.upload_status, "not_uploaded"),
          isNull(otherDocumentRequests.upload_status),
        ),
      ),
    );

  if (open.length === 0) {
    console.log(
      coBorrowerPending
        ? "\nNo open document requests (the co-borrower ask above is the only one)."
        : "\nNothing outstanding on this lead. Nothing to resend.",
    );
    return;
  }

  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  if (!base) {
    console.log("\nNEXT_PUBLIC_APP_URL is unset — the upload links would be relative and useless.");
    return;
  }

  const now = new Date();
  const items = [];
  for (const r of open) {
    if (!r.token) {
      console.log(`\nSKIP ${r.doc_label} — no upload_token on the row.`);
      continue;
    }
    if (r.expires && r.expires < now) {
      console.log(
        `\nSKIP ${r.doc_label} — token expired ${r.expires.toISOString()}.`,
        "Ask the admin to raise the request again so a fresh token is minted.",
      );
      continue;
    }
    items.push({
      id: r.id,
      docLabel: r.doc_label ?? "Document",
      uploadLink: `${base}/upload-docs/${leadId}/${r.id}/${r.token}`,
      reason: r.reason,
      docFor: (r.doc_for as "primary" | "co_borrower") ?? "primary",
    });
  }

  if (items.length === 0) {
    console.log("\nNothing sendable.");
    return;
  }

  console.log(`\nWould send ${items.length} item(s):`);
  for (const i of items) console.log(`  • ${i.docLabel}${i.reason ? ` — ${i.reason}` : ""}`);

  if (DRY_RUN) {
    console.log("\nDry run — nothing sent.");
    return;
  }

  // Group by doc_for: the copy differs ("your" vs "the co-borrower's"), and
  // mixing them in one message would misattribute half the list.
  const { pushDocRequestToWhatsApp } = await import(
    "../src/lib/whatsapp/doc-request-flow"
  );
  for (const docFor of ["primary", "co_borrower"] as const) {
    const group = items.filter((i) => i.docFor === docFor);
    if (group.length === 0) continue;
    await pushDocRequestToWhatsApp({ leadId, docFor, items: group });
    console.log(`\nPushed ${group.length} ${docFor} item(s) to WhatsApp.`);
  }
  console.log(
    "\nDone. Check whatsapp_messages for the outbound row, and the chat itself.",
  );
}

main()
  .catch((err) => {
    console.error("ERROR:", err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
