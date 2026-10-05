/**
 * E-321 — POST /api/dashboard/ceo/invoices/[id]/link
 *
 * The "Link to account" / "Not a dealer sale" actions on the unmatched-invoices
 * work list (tracker ID 69 / handover P1-6).
 *
 *   { source: 'zoho'|'drive', action: 'link', account_id, note? }
 *     Records the hand link (invoice_account_links, kind 'linked') AND teaches
 *     the matcher the invoice's GSTIN: it is added to account_gstins (source
 *     'invoice_link') so that dealer's FUTURE invoices match on their own,
 *     without anyone coming back to this page.
 *   { source, action: 'not_dealer', note? }
 *     Marks the invoice as not a dealer sale; it leaves the work list.
 *   { source, action: 'clear' }
 *     Removes the decision. The GSTIN alias a 'link' added is deliberately
 *     left in place — other invoices may already be matching through it.
 *
 * A GSTIN identifies exactly one account. If the invoice's GSTIN already
 * belongs to a DIFFERENT account (its primary GSTIN, or an alias), the link is
 * refused with 409 rather than making the next invoice ambiguous.
 *
 * Every action writes one audit_logs row (entity_type 'invoice').
 */
import { hasInvoiceLedgerTables } from "@/lib/sales/ledgerTables";
import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  accountGstins,
  accounts,
  auditLogs,
  invoiceAccountLinks,
} from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, generateId, isNextRedirectError } from "@/lib/api-utils";
import { hasAccountOwnershipTables } from "@/lib/accounts/tables";
import { isValidGstin, normalizeGstin } from "@/lib/leads/gstin";
import { GSTIN_KEY } from "@/lib/leads/gstinMatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin", "finance_controller"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BodySchema = z.object({
  // "credit" = a credit note (E-322, tracker ID 71).
  source: z.enum(["zoho", "drive", "credit"]),
  action: z.enum(["link", "not_dealer", "clear"]),
  account_id: z.string().trim().min(1).max(255).optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function fail(message: string, status: number) {
  return NextResponse.json({ success: false, error: { message } }, { status });
}

function rowsOf<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  return ((res as { rows?: T[] })?.rows ?? []) as T[];
}

/** The invoice's number and raw GSTIN, or null when no such invoice exists. */
async function loadInvoice(
  source: "zoho" | "drive" | "credit",
  id: string,
): Promise<{ invoice_number: string | null; gstin: string | null } | null> {
  const ledger = await hasInvoiceLedgerTables();
  if (source === "credit" && !ledger) return null;
  const res =
    source === "zoho"
      ? // E-322 (ID 70): the backfilled customer GSTIN first.
        await db.execute(sql`
          SELECT zi.invoice_number,
                 ${ledger ? sql`COALESCE(zcg.gstin, zi.raw_json->>'gst_no')` : sql`zi.raw_json->>'gst_no'`} AS gstin
            FROM zoho_invoices zi
            ${ledger
              ? sql`LEFT JOIN zoho_customer_gstins zcg
                           ON zcg.organization_id = COALESCE(zi.organization_id, '')
                          AND zcg.customer_id = zi.customer_id`
              : sql``}
           WHERE zi.id = ${id}::uuid`)
      : source === "credit"
        ? await db.execute(sql`
            SELECT note_number AS invoice_number, customer_gstin AS gstin
              FROM credit_notes WHERE id = ${id}::uuid`)
        : await db.execute(sql`
            SELECT invoice_number, customer_gstin AS gstin
              FROM sales_invoices WHERE id = ${id}::uuid`);
  return rowsOf<{ invoice_number: string | null; gstin: string | null }>(res)[0] ?? null;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireAuth();
    if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) {
      return fail("FORBIDDEN", 403);
    }

    if (!(await hasAccountOwnershipTables())) {
      return fail(
        "Invoice linking is not available yet: apply drizzle/E-321_account_ownership_list_price.sql to this database.",
        503,
      );
    }

    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) return fail("Invalid invoice id", 400);

    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: "Validation failed",
            details: parsed.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          },
        },
        { status: 400 },
      );
    }
    const { source, action } = parsed.data;
    const note = parsed.data.note?.trim() || null;

    if (source === "drive") {
      const res = await db.execute(
        sql`SELECT to_regclass('public.sales_invoices') IS NOT NULL AS ok`,
      );
      if (!rowsOf<{ ok: boolean }>(res)[0]?.ok) {
        return fail("No Drive invoices exist on this database.", 404);
      }
    }
    const invoice = await loadInvoice(source, id);
    if (!invoice) return fail(`No ${source} invoice with that id.`, 404);

    const [previous] = await db
      .select()
      .from(invoiceAccountLinks)
      .where(
        and(
          eq(invoiceAccountLinks.source, source),
          eq(invoiceAccountLinks.invoice_id, id),
        ),
      )
      .limit(1);
    const oldData = previous
      ? {
          kind: previous.kind,
          account_id: previous.account_id,
          note: previous.note,
        }
      : null;

    // ── clear ────────────────────────────────────────────────────────────────
    if (action === "clear") {
      await db.transaction(async (tx) => {
        await tx
          .delete(invoiceAccountLinks)
          .where(
            and(
              eq(invoiceAccountLinks.source, source),
              eq(invoiceAccountLinks.invoice_id, id),
            ),
          );
        await tx.insert(auditLogs).values({
          id: await generateId("AUDIT", auditLogs),
          entity_type: "invoice",
          entity_id: `${source}:${id}`,
          action: "invoice_link_clear",
          performed_by: user.id,
          old_data: oldData,
          new_data: { invoice_number: invoice.invoice_number },
        });
      });
      return NextResponse.json({ success: true, data: { kind: null } });
    }

    // ── not a dealer sale ────────────────────────────────────────────────────
    if (action === "not_dealer") {
      await db.transaction(async (tx) => {
        await tx
          .insert(invoiceAccountLinks)
          .values({
            source,
            invoice_id: id,
            account_id: null,
            kind: "not_dealer",
            note,
            linked_by: user.id,
          })
          .onConflictDoUpdate({
            target: [invoiceAccountLinks.source, invoiceAccountLinks.invoice_id],
            set: {
              account_id: null,
              kind: "not_dealer",
              note,
              linked_by: user.id,
              linked_at: new Date(),
            },
          });
        await tx.insert(auditLogs).values({
          id: await generateId("AUDIT", auditLogs),
          entity_type: "invoice",
          entity_id: `${source}:${id}`,
          action: "invoice_not_dealer",
          performed_by: user.id,
          old_data: oldData,
          new_data: { kind: "not_dealer", note, invoice_number: invoice.invoice_number },
        });
      });
      return NextResponse.json({ success: true, data: { kind: "not_dealer" } });
    }

    // ── link to an account ───────────────────────────────────────────────────
    const accountId = parsed.data.account_id;
    if (!accountId) return fail("account_id is required to link an invoice", 400);

    const [account] = await db
      .select({
        id: accounts.id,
        name: accounts.business_entity_name,
        gstin: accounts.gstin,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (!account) return fail(`No dealer account with id ${accountId}.`, 404);

    // Only a well-formed GSTIN is worth teaching the matcher; anything else
    // could never match a future invoice and would not fit the 15-char column.
    const gstin = normalizeGstin(invoice.gstin);
    const teachGstin =
      isValidGstin(gstin) && gstin !== normalizeGstin(account.gstin) ? gstin : null;

    let gstinAdded = false;
    await db.transaction(async (tx) => {
      if (teachGstin) {
        // A GSTIN may identify only one account: refuse if another account
        // already carries it as its primary GSTIN or as an alias.
        const owners = rowsOf<{ id: string; name: string }>(
          await tx.execute(sql`
            SELECT a.id, a.business_entity_name AS name
              FROM accounts a
             WHERE a.id <> ${account.id}
               AND (${GSTIN_KEY(sql`a.gstin`)} = ${teachGstin}
                    OR EXISTS (SELECT 1 FROM account_gstins g
                                WHERE g.account_id = a.id AND g.gstin = ${teachGstin}))
             LIMIT 1
          `),
        );
        if (owners[0]) {
          throw new HttpError(
            `GSTIN ${teachGstin} on this invoice already belongs to ${owners[0].name} (${owners[0].id}). ` +
              `Link the invoice to that account, or correct the GSTIN there first.`,
            409,
          );
        }
        const inserted = await tx
          .insert(accountGstins)
          .values({
            gstin: teachGstin,
            account_id: account.id,
            source: "invoice_link",
            added_by: user.id,
          })
          .onConflictDoNothing()
          .returning({ gstin: accountGstins.gstin });
        gstinAdded = inserted.length > 0;
      }

      await tx
        .insert(invoiceAccountLinks)
        .values({
          source,
          invoice_id: id,
          account_id: account.id,
          kind: "linked",
          note,
          linked_by: user.id,
        })
        .onConflictDoUpdate({
          target: [invoiceAccountLinks.source, invoiceAccountLinks.invoice_id],
          set: {
            account_id: account.id,
            kind: "linked",
            note,
            linked_by: user.id,
            linked_at: new Date(),
          },
        });

      await tx.insert(auditLogs).values({
        id: await generateId("AUDIT", auditLogs),
        entity_type: "invoice",
        entity_id: `${source}:${id}`,
        action: "invoice_link",
        performed_by: user.id,
        old_data: oldData,
        new_data: {
          kind: "linked",
          account_id: account.id,
          note,
          invoice_number: invoice.invoice_number,
          gstin_added: gstinAdded ? teachGstin : null,
        },
      });
    });

    return NextResponse.json({
      success: true,
      data: {
        kind: "linked",
        account_id: account.id,
        account_name: account.name,
        gstin_added: gstinAdded ? teachGstin : null,
      },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    if (e instanceof HttpError) return fail(e.message, e.status);
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}
