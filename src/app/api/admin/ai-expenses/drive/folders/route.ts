/**
 * E-216 — /api/admin/ai-expenses/drive/folders
 *
 * CRUD for the Google Drive folders the expense scanner reads.
 *
 * The list lives in the DB rather than an env var because production's
 * shared/.env is rewritten from the PROD_ENV_FILE_B64 GitHub secret on every
 * deploy — an env-configured folder list would silently disappear the next
 * time anyone shipped.
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
import { driveExpenseFolders } from "@/lib/db/schema";
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
  // A pasted Drive URL or a bare folder id — whatever came out of the address bar.
  folder: z.string().trim().min(1).max(512),
  label: z.string().trim().max(160).optional().nullable(),
  recursive: z.boolean().optional(),
  // Allowlist of folder names whose contents get imported. Omit to keep the
  // 'purchase' default, which is what keeps customer invoices out of expenses.
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
      .from(driveExpenseFolders)
      .orderBy(desc(driveExpenseFolders.created_at));

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
    const user = guard.user;

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
      .select({ id: driveExpenseFolders.id })
      .from(driveExpenseFolders)
      .where(eq(driveExpenseFolders.drive_folder_id, folderId))
      .limit(1);
    if (existing) {
      return NextResponse.json(
        {
          success: false,
          error: { code: "ALREADY_ADDED", message: "That folder is already configured." },
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
      .insert(driveExpenseFolders)
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
        created_by: user.id,
      })
      .returning();

    return NextResponse.json({ success: true, data: { folder: row } }, { status: 201 });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    const msg = errorMessage(e);
    console.error("[drive/folders POST] error:", msg);
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
      .update(driveExpenseFolders)
      .set(update)
      .where(eq(driveExpenseFolders.id, id))
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

    // Removing a folder stops future scans. It deliberately does NOT delete the
    // expenses already imported from it — those are real spend, and the run
    // history keeps its ON DELETE SET NULL reference for the audit trail.
    const [row] = await db
      .delete(driveExpenseFolders)
      .where(eq(driveExpenseFolders.id, id))
      .returning({ id: driveExpenseFolders.id });

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
