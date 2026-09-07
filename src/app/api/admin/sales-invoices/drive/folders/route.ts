/**
 * E-280 — /api/admin/sales-invoices/drive/folders
 *
 * CRUD for the Google Drive folders the SALES scanner reads. The expense-side
 * twin is /api/admin/ai-expenses/drive/folders and this follows it closely; the
 * two lists are separate rows in separate tables so the same accounts root can
 * be registered once for purchases and once for sales, with opposite filters.
 *
 * The list lives in the DB rather than an env var because production's
 * shared/.env is rewritten from the PROD_ENV_FILE_B64 GitHub secret on every
 * deploy — an env-configured folder list would silently disappear the next time
 * anyone shipped.
 *
 * POST verifies the folder is reachable BEFORE storing it. A service account
 * has no Drive of its own, so a folder nobody shared with it lists as empty
 * rather than erroring; catching that at add-time is the difference between
 * "that folder isn't shared with the service account" and a scanner that
 * cheerfully reports zero new invoices forever.
 */
import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { salesInvoiceFolders } from "@/lib/db/schema";
import { requireApiAdmin } from "@/lib/auth/requireApiAdmin";
import { isNextRedirectError, errorMessage } from "@/lib/api-utils";
import {
  describeDriveError,
  getFolderName,
  isDriveConfigured,
  parseDriveFolderId,
} from "@/lib/google/drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  folder: z.string().trim().min(1).max(512),
  label: z.string().trim().max(160).optional().nullable(),
  recursive: z.boolean().optional(),
  // Allowlist of folder names whose contents get imported. Omit to keep the
  // 'sale' default, which is what keeps supplier bills out of revenue.
  include_names: z.string().trim().max(512).optional(),
  exclude_names: z.string().trim().max(512).optional(),
});

const PatchSchema = z
  .object({
    id: z.string().uuid(),
    is_active: z.boolean().optional(),
    recursive: z.boolean().optional(),
    label: z.string().trim().max(160).nullable().optional(),
    include_names: z.string().trim().max(512).optional(),
    exclude_names: z.string().trim().max(512).optional(),
  })
  .refine((o) => Object.keys(o).length > 1, { message: "No fields to update" });

export async function GET() {
  try {
    const guard = await requireApiAdmin();
    if (!guard.ok) return guard.response;

    const rows = await db
      .select()
      .from(salesInvoiceFolders)
      .orderBy(desc(salesInvoiceFolders.created_at));

    return NextResponse.json({
      success: true,
      data: { folders: rows, drive_configured: isDriveConfigured() },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireApiAdmin();
    if (!guard.ok) return guard.response;

    if (!isDriveConfigured()) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              "Google Drive is not configured on this server — GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY must be set.",
          },
        },
        { status: 400 },
      );
    }

    const parsed = CreateSchema.safeParse(await req.json());
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

    const folderId = parseDriveFolderId(parsed.data.folder);
    if (!folderId) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              "That does not look like a Drive folder. Paste the folder's URL or its id.",
          },
        },
        { status: 400 },
      );
    }

    const [existing] = await db
      .select({ id: salesInvoiceFolders.id })
      .from(salesInvoiceFolders)
      .where(eq(salesInvoiceFolders.drive_folder_id, folderId))
      .limit(1);
    if (existing) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "ALREADY_ADDED",
            message: "That folder is already configured for sales.",
          },
        },
        { status: 409 },
      );
    }

    // Reachability check — see the header comment.
    let discoveredName: string | null = null;
    try {
      discoveredName = await getFolderName(folderId);
    } catch (err) {
      return NextResponse.json(
        { success: false, error: { message: describeDriveError(err) } },
        { status: 400 },
      );
    }

    const [row] = await db
      .insert(salesInvoiceFolders)
      .values({
        drive_folder_id: folderId,
        label: parsed.data.label?.trim() || discoveredName || folderId,
        recursive: parsed.data.recursive ?? true,
        ...(parsed.data.include_names !== undefined
          ? { include_names: parsed.data.include_names }
          : {}),
        ...(parsed.data.exclude_names !== undefined
          ? { exclude_names: parsed.data.exclude_names }
          : {}),
        created_by: guard.user.id,
      })
      .returning();

    return NextResponse.json({ success: true, data: { folder: row } }, { status: 201 });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    const msg = errorMessage(e);
    console.error("[sales drive/folders POST] error:", msg);
    return NextResponse.json({ success: false, error: { message: msg } }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const guard = await requireApiAdmin();
    if (!guard.ok) return guard.response;

    const parsed = PatchSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { message: "Validation failed" } },
        { status: 400 },
      );
    }
    const { id, ...fields } = parsed.data;

    const update: Record<string, unknown> = { updated_at: new Date() };
    if (fields.is_active !== undefined) update.is_active = fields.is_active;
    if (fields.recursive !== undefined) update.recursive = fields.recursive;
    if (fields.label !== undefined) update.label = fields.label || null;
    if (fields.include_names !== undefined) update.include_names = fields.include_names;
    if (fields.exclude_names !== undefined) update.exclude_names = fields.exclude_names;

    const [row] = await db
      .update(salesInvoiceFolders)
      .set(update)
      .where(eq(salesInvoiceFolders.id, id))
      .returning();

    if (!row) {
      return NextResponse.json(
        { success: false, error: { message: "Not found" } },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, data: { folder: row } });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const guard = await requireApiAdmin();
    if (!guard.ok) return guard.response;

    const id = req.nextUrl.searchParams.get("id");
    if (!id) {
      return NextResponse.json(
        { success: false, error: { message: "id is required" } },
        { status: 400 },
      );
    }

    // Only the folder registration goes. Invoices already imported from it stay
    // — they are revenue, and removing a folder is a config change, not a
    // decision to un-earn what it found.
    const [row] = await db
      .delete(salesInvoiceFolders)
      .where(eq(salesInvoiceFolders.id, id))
      .returning({ id: salesInvoiceFolders.id });

    if (!row) {
      return NextResponse.json(
        { success: false, error: { message: "Not found" } },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, data: { id: row.id } });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}
