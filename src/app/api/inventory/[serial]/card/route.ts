import { NextRequest, NextResponse } from "next/server";
import { desc, eq, or } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  accounts,
  deployedAssets,
  inventory,
  inventoryEvents,
  leads,
  loanSanctions,
  products,
  users,
} from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";

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

    if (user.role === "dealer" && inv.dealer_id !== user.dealer_id) {
      return NextResponse.json(
        { success: false, error: { message: "Access denied" } },
        { status: 403 },
      );
    }

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
                })
                .from(products)
                .where(eq(products.id, inv.product_id!))
                .limit(1)
            )[0] ?? null,
          null as {
            name: string;
            voltage_v: number | null;
            capacity_ah: number | null;
            warranty_months: number | null;
          } | null,
        )
      : null;

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
          null as {
            id: string;
            business_entity_name: string | null;
            dealer_code: string | null;
            city: string | null;
            state: string | null;
          } | null,
        )
      : null;

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
          null as {
            id: string;
            full_name: string | null;
            owner_name: string | null;
            kyc_status: string | null;
            dealer_id: string | null;
          } | null,
        )
      : null;

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
      null as {
        id: string;
        warranty_start_date: Date | null;
        warranty_end_date: Date | null;
        warranty_status: string | null;
        deployment_date: Date | null;
      } | null,
    );

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

    const ageDays = inv.created_at
      ? Math.floor(
          (Date.now() - new Date(inv.created_at).getTime()) /
            (1000 * 60 * 60 * 24),
        )
      : null;

    const eventRows = await safe(
      async () =>
        db
          .select({
            eventType: inventoryEvents.event_type,
            fromStatus: inventoryEvents.from_status,
            toStatus: inventoryEvents.to_status,
            leadId: inventoryEvents.lead_id,
            notes: inventoryEvents.notes,
            performedAt: inventoryEvents.performed_at,
            actorName: users.name,
          })
          .from(inventoryEvents)
          .leftJoin(users, eq(users.id, inventoryEvents.performed_by))
          .where(
            or(
              eq(inventoryEvents.serial_number, serial),
              eq(inventoryEvents.inventory_id, inv.id),
            ),
          )
          .orderBy(desc(inventoryEvents.performed_at))
          .limit(100),
      [] as Array<{
        eventType: string;
        fromStatus: string | null;
        toStatus: string | null;
        leadId: string | null;
        notes: string | null;
        performedAt: Date;
        actorName: string | null;
      }>,
    );

    const labelByEvent: Record<string, string> = {
      uploaded: "Uploaded",
      reserved: "Reserved",
      released: "Released",
      sold: "Sold",
      written_off: "Written Off",
      transfer_initiated: "Transfer Initiated",
      transfer_received: "Transfer Acknowledged",
      iot_linked: "IoT Linked",
      edited: "Updated",
    };

    const history = eventRows.map((e) => {
      const label = labelByEvent[e.eventType] || e.eventType.replace(/_/g, " ");
      const detail = e.notes
        ? e.notes
        : e.fromStatus && e.toStatus
          ? `${e.fromStatus} -> ${e.toStatus}`
          : e.toStatus
            ? `Status: ${e.toStatus}`
            : "Inventory event recorded";
      return {
        at: e.performedAt.toISOString(),
        label,
        detail: e.leadId ? `${detail} (Lead: ${e.leadId})` : detail,
        actor: e.actorName,
      };
    });

    if (history.length === 0) {
      history.push({
        at: new Date(inv.created_at).toISOString(),
        label: "Created",
        detail: "Inventory row created",
        actor: null,
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        serial_number: inv.serial_number,
        inventory_id: inv.id,
        imei_id: inv.iot_imei_no,
        iot_enabled: inv.iot_enabled,
        material_code: inv.material_code,
        category: inv.asset_category,
        sub_category: inv.sub_category,
        model_number: inv.model_type,
        product_name: productRow?.name ?? null,
        voltage_v: inv.voltage_v ?? productRow?.voltage_v ?? null,
        capacity_ah: inv.capacity_ah ?? productRow?.capacity_ah ?? null,
        star_rating: inv.star_rating,
        physical_condition: inv.physical_condition,
        supplier_name: inv.oem_name,
        invoice_number: inv.oem_invoice_number,
        invoice_date: inv.oem_invoice_date,
        invoice_value: inv.inventory_amount,
        gst_amount: inv.gst_amount,
        final_amount: inv.final_amount,
        inventory_age_days: ageDays,
        soc_percent: inv.soc_percent,
        soc_last_sync_at: inv.soc_last_sync_at,
        oem_warranty_date: inv.oem_warranty_date,
        oem_warranty_months: inv.oem_warranty_months,
        oem_warranty_expiry: inv.oem_warranty_expiry,
        oem_warranty_clauses: inv.oem_warranty_clauses,
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
