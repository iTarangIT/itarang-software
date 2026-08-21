/**
 * Google Drive mirror — admin settings + controls (E-255).
 *
 *   GET  → settings, credential status, ledger counts, recent failures/successes
 *   PUT  → save settings (enabled / rootFolderId / impersonateUser)
 *   POST → an action: { action: "test" | "backfill" | "process" | "retry_failed" | "disconnect_oauth" }
 *
 * Kept out of the `/api/admin/settings` bundle for the same reason
 * `/api/admin/settings/nbfc-request-sla` is: it is a singleton unrelated to
 * the assignment / holiday / territory triple.
 */

import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { parseDriveFolderId } from "@/lib/google/drive";
import {
    getDriveMirrorSettings,
    setDriveMirrorSettings,
} from "@/lib/storage/drive-mirror-settings";
import {
    getDriveMirrorStatus,
    invalidateDriveMirrorSettingsCache,
    isDriveMirrorCredentialConfigured,
    probeDriveMirror,
    retryFailedNow,
    runDriveMirrorBackfill,
    runDriveMirrorTick,
} from "@/lib/storage/drive-mirror";
import {
    DRIVE_LAYOUT_RULES,
    DRIVE_MIRROR_EXCLUDED_BUCKETS,
    isRuleIncluded,
} from "@/lib/storage/drive-mirror-layout";
import { describeDriveOAuth, disconnectDriveOAuth } from "@/lib/storage/drive-mirror-oauth";
import { isS3Backend } from "@/lib/storage/s3";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const EDITOR_ROLES = ["admin", "sales_head"];

const BodySchema = z.object({
    enabled: z.boolean().optional(),
    /** A bare folder id or any Drive folder URL; normalised to the id. */
    rootFolderId: z.string().max(2048).nullable().optional(),
    impersonateUser: z.string().max(320).nullable().optional(),
});

const ActionSchema = z.object({
    action: z.enum(["test", "backfill", "process", "retry_failed", "disconnect_oauth"]),
    /** For "process": how many rows to attempt in this call. */
    max: z.number().int().min(1).max(200).optional(),
});

async function payload() {
    const settings = await getDriveMirrorSettings();
    const status = await getDriveMirrorStatus().catch((err: unknown) => ({
        error: err instanceof Error ? err.message : String(err),
    }));
    return {
        settings,
        credential: {
            configured: isDriveMirrorCredentialConfigured(),
            serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || null,
        },
        oauth: await describeDriveOAuth(),
        storageBackend: isS3Backend ? "s3" : "supabase",
        // The category folders the mirror creates, for the "how files are
        // organised" table. Deduped on folder path so the page lists each
        // Drive folder once with every S3 source that feeds it.
        layout: (() => {
            const byFolder = new Map<
                string,
                { folder: string; sources: string[]; description: string; included: boolean }
            >();
            for (const r of DRIVE_LAYOUT_RULES) {
                const folder = r.folder.join(" / ");
                const source = `${r.bucket}/${r.prefix || "*"}`;
                const cur = byFolder.get(folder);
                if (cur) cur.sources.push(source);
                else
                    byFolder.set(folder, {
                        folder,
                        sources: [source],
                        description: r.description,
                        included: isRuleIncluded(r),
                    });
            }
            const rows = [...byFolder.values()].sort((a, b) => Number(b.included) - Number(a.included));
            for (const b of DRIVE_MIRROR_EXCLUDED_BUCKETS) {
                rows.push({
                    folder: "Call Recordings",
                    sources: [`${b}/*`],
                    description: "AI-dialer and uploaded call recordings",
                    included: false,
                });
            }
            return rows;
        })(),
        status,
    };
}

export const GET = withErrorHandler(async () => {
    await requireRole(EDITOR_ROLES);
    return successResponse(await payload());
});

export const PUT = withErrorHandler(async (req: Request) => {
    await requireRole(EDITOR_ROLES);
    const patch = BodySchema.parse(await req.json());
    const next: Parameters<typeof setDriveMirrorSettings>[0] = {};
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.rootFolderId !== undefined) {
        if (patch.rootFolderId === null || patch.rootFolderId.trim() === "") {
            next.rootFolderId = null;
        } else {
            const id = parseDriveFolderId(patch.rootFolderId);
            if (!id) {
                const err = new Error("That does not look like a Google Drive folder id or URL.");
                (err as { status?: number }).status = 400;
                throw err;
            }
            next.rootFolderId = id;
        }
    }
    if (patch.impersonateUser !== undefined) {
        next.impersonateUser = patch.impersonateUser ? patch.impersonateUser.trim() : null;
    }
    await setDriveMirrorSettings(next);
    invalidateDriveMirrorSettingsCache();
    return successResponse(await payload());
});

export const POST = withErrorHandler(async (req: Request) => {
    await requireRole(EDITOR_ROLES);
    const body = ActionSchema.parse(await req.json());
    let result: unknown;
    switch (body.action) {
        case "test":
            result = await probeDriveMirror();
            break;
        case "backfill":
            result = await runDriveMirrorBackfill();
            break;
        case "process":
            result = await runDriveMirrorTick({ max: body.max ?? 25, timeBudgetMs: 45_000 });
            break;
        case "retry_failed":
            result = { reset: await retryFailedNow() };
            break;
        case "disconnect_oauth":
            await disconnectDriveOAuth();
            invalidateDriveMirrorSettingsCache();
            result = { disconnected: true };
            break;
    }
    return successResponse({ action: body.action, result, ...(await payload()) });
});
