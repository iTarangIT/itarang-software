import { NextRequest, NextResponse } from "next/server";
import { desc, eq, or } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  accounts,
  deployedAssets,
  inventory,
  inventoryTransfers,
  inventoryUploadReports,
  leads,
  loanSanctions,
  productSelections,
  products,
  users,
} from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";

// BRD V2 §5.0.5 — Battery / Charger Detail Card (read-only).
// Returns the full payload for the modal that opens when the dealer (or
// admin) clicks any serial number. Combines inventory row + product master
// spec + dealer + active lead + status history (uploaded → reserved →
// released → reserved-again → ...).
//
// Auth:
//   - dealers: only their own serials.
//   - admin / inventory_admin tier: any serial.

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ serial: string }> },
) {
  try {
    const user = await requireAuth();
    const { serial } = await params;

    const [inv] = await db
      .select()
      .from(inventory)
      .where(eq(inventory.serial_number, serial))
      .limit(1);

    if (!inv) {
      return NextResponse.json(
        { success: false, error: { message: "Serial not found" } },
        { status: 404 },
      );
    }

    // Dealers can only see their own inventory. Other roles fall through.
    if (user.role === "dealer" && inv.dealer_id !== user.dealer_id) {
      return NextResponse.json(
        { success: false, error: { message: "Access denied" } },
        { status: 403 },
      );
    }

    // Each lookup below is wrapped in a tolerant helper so a missing /
    // out-of-sync auxiliary table doesn't break the modal. The core
    // `inventory` row is what matters for the user; everything else is
    // optional enrichment.
    const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        console.warn(
          "[Inventory Detail Card] aux query failed:",
          e instanceof Error ? e.message : e,
        );
        return fallback;
      }
    };

    // Product master spec — voltage / capacity / chemistry / warranty months.
    const productRow = inv.product_id
      ? await safe(
          async () =>
            (
              await db
                .select({
                  name: products.name,
                  voltage_v: products.voltage_v,
                  capacity_ah: products.capacity_ah,
                  warranty_months: products.warranty_months,
                  hsn_code: products.hsn_code,
                })
                .from(products)
                .where(eq(products.id, inv.product_id!))
                .limit(1)
            )[0] ?? null,
          null as { name: string; voltage_v: number | null; capacity_ah: number | null; warranty_months: number | null; hsn_code: string | null } | null,
        )
      : null;

    // Dealer that currently owns the row.
    const dealerRow = inv.dealer_id
      ? await safe(
          async () =>
            (
              await db
                .select({
                  id: accounts.id,
                  business_entity_name: accounts.business_entity_name,
                  dealer_code: accounts.dealer_code,
                  city: accounts.city,
                  state: accounts.state,
                })
                .from(accounts)
                .where(eq(accounts.id, inv.dealer_id!))
                .limit(1)
            )[0] ?? null,
          null as { id: string; business_entity_name: string | null; dealer_code: string | null; city: string | null; state: string | null } | null,
        )
      : null;

    // Linked lead (when reserved or sold).
    const linkedLead = inv.linked_lead_id
      ? await safe(
          async () =>
            (
              await db
                .select({
                  id: leads.id,
                  full_name: leads.full_name,
                  owner_name: leads.owner_name,
                  kyc_status: leads.kyc_status,
                  dealer_id: leads.dealer_id,
                })
                .from(leads)
                .where(eq(leads.id, inv.linked_lead_id!))
                .limit(1)
            )[0] ?? null,
          null as { id: string; full_name: string | null; owner_name: string | null; kyc_status: string | null; dealer_id: string | null } | null,
        )
      : null;

    // Warranty record (after dispatch).
    const warranty = await safe(
      async () =>
        (
          await db
            .select({
              id: deployedAssets.id,
              warranty_start_date: deployedAssets.warranty_start_date,
              warranty_end_date: deployedAssets.warranty_end_date,
              warranty_status: deployedAssets.warranty_status,
              deployment_date: deployedAssets.deployment_date,
            })
            .from(deployedAssets)
            .where(eq(deployedAssets.serial_number, serial))
            .limit(1)
        )[0] ?? null,
      null as { id: string; warranty_start_date: Date | null; warranty_end_date: Date | null; warranty_status: string | null; deployment_date: Date | null } | null,
    );

    // Last loan sanction (when financed).
    const loan = inv.linked_lead_id
      ? await safe(
          async () =>
            (
              await db
                .select()
                .from(loanSanctions)
                .where(eq(loanSanctions.lead_id, inv.linked_lead_id!))
                .orderBy(desc(loanSanctions.created_at))
                .limit(1)
            )[0] ?? null,
          null as typeof loanSanctions.$inferSelect | null,
        )
      : null;

    // Inventory age in days, computed once.
    const ageDays = inv.oem_invoice_date
      ? Math.floor(
          (Date.now() - new Date(inv.oem_invoice_date).getTime()) /
            (1000 * 60 * 60 * 24),
        )
      : null;

    // Status history — synthesise from upload report + recent product
    // selections + transfers. Dedicated `inventory_events` audit log is on
    // the BRD roadmap; until then we reconstruct chronology from these
    // sources so the modal still shows movement.
    const history: {
      at: string;
      label: string;
      detail: string;
      actor?: string | null;
    }[] = [];

    // Each augmentation query below is wrapped in try/catch so the modal
    // still renders even when an auxiliary table (inventory_upload_reports,
    // inventory_transfers, product_selections) is missing or out-of-date in
    // the database. Status history degrades gracefully — the core inventory
    // row + dealer + warranty info always come back.

    // --- Upload event lookup (optional) -----------------------------------
    let uploadEvent: Array<{
      id: string;
      uploaded_at: Date | string;
      uploaded_by: string;
      source: string;
    }> = [];
    try {
      uploadEvent = (await db
        .select({
          id: inventoryUploadReports.id,
          uploaded_at: inventoryUploadReports.uploaded_at,
          uploaded_by: inventoryUploadReports.uploaded_by,
          source: inventoryUploadReports.source,
        })
        .from(inventoryUploadReports)
        .where(eq(inventoryUploadReports.dealer_id, inv.dealer_id ?? ""))
        .orderBy(desc(inventoryUploadReports.uploaded_at))
        .limit(5)) as typeof uploadEvent;
    } catch (e) {
      console.warn(
        "[Inventory Detail Card] inventory_upload_reports lookup failed:",
        e instanceof Error ? e.message : e,
      );
    }

    const matchUpload = uploadEvent.find(
      (u) =>
        new Date(u.uploaded_at).getTime() <=
        new Date(inv.created_at).getTime() + 60_000,
    );
    if (matchUpload) {
      let uploaderName: string | null = null;
      try {
        const [uploader] = await db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, matchUpload.uploaded_by))
          .limit(1);
        uploaderName = uploader?.name ?? null;
      } catch {
        // ignore — uploader name is cosmetic
      }
      history.push({
        at: matchUpload.uploaded_at as unknown as string,
        label: "Uploaded",
        detail: `Source: ${matchUpload.source}`,
        actor: uploaderName,
      });
    } else {
      history.push({
        at: inv.created_at as unknown as string,
        label: "Created",
        detail: "Inventory row created",
        actor: null,
      });
    }

    // --- Reservations / releases (optional) -------------------------------
    let selections: Array<{
      id: string;
      lead_id: string;
      admin_decision: string | null;
      submitted_at: Date | string | null;
      updated_at: Date | string;
      battery_serial: string | null;
      charger_serial: string | null;
    }> = [];
    try {
      selections = (await db
        .select({
          id: productSelections.id,
          lead_id: productSelections.lead_id,
          admin_decision: productSelections.admin_decision,
          submitted_at: productSelections.submitted_at,
          updated_at: productSelections.updated_at,
          battery_serial: productSelections.battery_serial,
          charger_serial: productSelections.charger_serial,
        })
        .from(productSelections)
        .where(
          or(
            eq(productSelections.battery_serial, serial),
            eq(productSelections.charger_serial, serial),
          ),
        )
        .orderBy(desc(productSelections.created_at))
        .limit(20)) as typeof selections;
    } catch (e) {
      console.warn(
        "[Inventory Detail Card] product_selections lookup failed:",
        e instanceof Error ? e.message : e,
      );
    }

    for (const s of selections) {
      if (s.submitted_at) {
        history.push({
          at: s.submitted_at as unknown as string,
          label: "Reserved",
          detail: `Lead ${s.lead_id} (Step 4 submit)`,
        });
      }
      if (
        s.admin_decision === "rejected" ||
        s.admin_decision === "draft"
      ) {
        history.push({
          at: s.updated_at as unknown as string,
          label: s.admin_decision === "rejected" ? "Released" : "Draft",
          detail: `Lead ${s.lead_id} → ${s.admin_decision}`,
        });
      }
      if (s.admin_decision === "dealer_confirmed") {
        history.push({
          at: s.updated_at as unknown as string,
          label: "Dispatched / Sold",
          detail: `Lead ${s.lead_id}`,
        });
      }
    }

    // --- Transfers (optional — table may not exist yet) -------------------
    let transfers: Array<typeof inventoryTransfers.$inferSelect> = [];
    try {
      transfers = await db
        .select()
        .from(inventoryTransfers)
        .orderBy(desc(inventoryTransfers.initiated_at))
        .limit(20);
    } catch (e) {
      console.warn(
        "[Inventory Detail Card] inventory_transfers lookup failed:",
        e instanceof Error ? e.message : e,
      );
    }
    for (const t of transfers) {
      const serials = (t.serials as string[]) ?? [];
      if (!serials.includes(serial)) continue;
      history.push({
        at: t.initiated_at as unknown as string,
        label: "Transfer initiated",
        detail: `${t.source_dealer_id} → ${t.target_dealer_id}`,
      });
      if (t.acknowledged_at) {
        history.push({
          at: t.acknowledged_at as unknown as string,
          label: "Transfer acknowledged",
          detail: `Status: ${t.status}`,
        });
      }
    }

    // Sort chronologically (newest first matches BRD detail-card style).
    history.sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    );

    return NextResponse.json({
      success: true,
      data: {
        serial_number: inv.serial_number,
        inventory_id: inv.id,
        imei_id: inv.iot_imei_no,
        iot_enabled: !!inv.iot_imei_no,
        material_code: inv.hsn_code, // closest existing column until material_code lands
        category: inv.asset_category,
        sub_category: inv.asset_type,
        model_number: inv.model_type,
        product_name: productRow?.name ?? null,
        voltage_v: productRow?.voltage_v ?? null,
        capacity_ah: productRow?.capacity_ah ?? null,
        // BRD field 10 — schema gap, surface null until column exists.
        star_rating: null,
        physical_condition: null,
        supplier_name: inv.oem_name,
        invoice_number: inv.oem_invoice_number,
        invoice_date: inv.oem_invoice_date,
        invoice_value: inv.inventory_amount,
        gst_amount: inv.gst_amount,
        final_amount: inv.final_amount,
        inventory_age_days: ageDays,
        soc_percent: inv.soc_percent,
        soc_last_sync_at: inv.soc_last_sync_at,
        // OEM warranty — schema today only stores a single warranty_months.
        oem_warranty_date: inv.manufacturing_date,
        oem_warranty_months: inv.warranty_months,
        oem_warranty_expiry: inv.expiry_date,
        oem_warranty_clauses: null, // schema gap
        batch_reference: inv.batch_number,
        warehouse_location: inv.warehouse_location,
        status: inv.status,
        sold_at: inv.sold_at,
        dispatch_date: inv.dispatch_date,
        dealer: dealerRow,
        linked_lead: linkedLead,
        loan_sanction: loan
          ? {
              id: loan.id,
              status: loan.status,
              loan_approved_by: loan.loan_approved_by,
            }
          : null,
        warranty,
        history,
      },
    });
  } catch (error) {
    console.error("[Inventory Detail Card] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to load detail card";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
