// Reports › Data downloads, one dataset (tracker ID 13).
//
// GET  ?<filters>     how many rows match — shown before anything is downloaded.
// POST { params, format, full_phone, reason, columns, background }
//                     the file: Excel (with "About this file") or CSV. With
//                     `background`, the file is prepared after the response and
//                     emailed to the person as a link (202).
// PUT  { columns }    "Save as my column set" — remembered per person.
//
// The rules every dataset shares live here, once:
//   * a rep role gets only the rows it owns (ID 58);
//   * phone numbers are masked unless an Admin or CEO asks for full numbers and
//     types a reason;
//   * more than DOWNLOAD_ROW_CAP rows does not download at once — it is prepared
//     in the background where the dataset allows it, and refused with a request
//     to narrow the filters otherwise. Never silently cut short;
//   * every download is logged: who, dataset, filters, rows, full numbers or not.

import { after } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { logDataDownload } from "@/lib/exports/downloadLog";
import { prepareAndEmail } from "@/lib/exports/datasets/background";
import { saveColumnSet } from "@/lib/exports/datasets/columnSets";
import { datasetAccess, datasetById, type RunContext } from "@/lib/exports/datasets/registry";
import {
    BACKGROUND_LINK_HOURS,
    BACKGROUND_ROW_CAP,
    DOWNLOAD_ROW_CAP,
    FULL_PHONE_REASON_MIN,
    FULL_PHONE_ROLES,
    pickColumns,
} from "@/lib/exports/datasets/types";
import { buildCsv, buildXlsx } from "@/lib/exports/datasets/workbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ dataset: string }> };

async function open(context: Ctx, params: URLSearchParams) {
    const user = await requireAuth();
    const dataset = datasetById((await context.params).dataset);
    const access = dataset ? datasetAccess(dataset, user.role) : null;
    if (!dataset || !access) return null;
    const run: RunContext = { params, user, ownOnly: access.ownOnly };
    return { user, dataset, run };
}

const tooMany = (n: number, cap: number) =>
    errorResponse(
        `${n.toLocaleString("en-IN")} rows match; a download is limited to ${cap.toLocaleString("en-IN")}. Narrow the date range or the filters and try again.`,
        400,
    );

export const GET = withErrorHandler(async (req: Request, context: Ctx) => {
    const opened = await open(context, new URL(req.url).searchParams);
    if (!opened) return errorResponse("This download is not available to your role.", 403);
    const count = await opened.dataset.count(opened.run);
    return successResponse({ count, over_cap: count > DOWNLOAD_ROW_CAP, own_only: opened.run.ownOnly });
});

const Body = z.object({
    params: z.record(z.string(), z.string()).default({}),
    format: z.enum(["xlsx", "csv"]).default("xlsx"),
    full_phone: z.boolean().default(false),
    reason: z.string().trim().max(300).optional(),
    /** Column keys to keep on the first sheet; absent or empty = every column. */
    columns: z.array(z.string().max(80)).max(200).optional(),
    background: z.boolean().default(false),
});

export const POST = withErrorHandler(async (req: Request, context: Ctx) => {
    const body = Body.parse(await req.json());
    const clean = Object.fromEntries(Object.entries(body.params).filter(([, v]) => v.trim() !== ""));
    const opened = await open(context, new URLSearchParams(clean));
    if (!opened) return errorResponse("This download is not available to your role.", 403);
    const { user, dataset, run } = opened;

    let fullPhone = false;
    if (body.full_phone) {
        if (!(FULL_PHONE_ROLES as readonly string[]).includes((user.role ?? "").toLowerCase())) {
            return errorResponse("Full phone numbers are for Admin and CEO only.", 403);
        }
        if ((body.reason ?? "").length < FULL_PHONE_REASON_MIN) {
            return errorResponse("Type the reason you need full phone numbers.", 400);
        }
        fullPhone = true;
    }

    const fileCtx = {
        datasetLabel: dataset.label,
        downloadedBy: `${user.name ?? user.email} (${user.role})`,
        filters: clean,
        fullPhone,
        ownOnly: run.ownOnly,
    };
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const name = `${dataset.id.replace(/_/g, "-")}-${stamp}`;

    const count = await dataset.count(run);

    if (body.background) {
        if (!dataset.background) return errorResponse("This dataset cannot be prepared in the background. Narrow the filters instead.", 400);
        if (!user.email) return errorResponse("Your login has no email address to send the link to.", 400);
        if (count > BACKGROUND_ROW_CAP) return tooMany(count, BACKGROUND_ROW_CAP);
        const baseUrl = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin).replace(/\/$/, "");
        // `user` and `run` are resolved above: the request context is gone inside after().
        after(() => prepareAndEmail({ dataset, run, fileCtx, format: body.format, columns: body.columns, name, baseUrl, reason: body.reason }));
        return successResponse({ background: true, sent_to: user.email, rows: count, link_hours: BACKGROUND_LINK_HOURS }, 202);
    }

    if (count > DOWNLOAD_ROW_CAP) return tooMany(count, DOWNLOAD_ROW_CAP);

    const sheets = await dataset.build(run);
    const rowCount = sheets[0]?.rows.length ?? 0;
    if (rowCount > DOWNLOAD_ROW_CAP) return tooMany(rowCount, DOWNLOAD_ROW_CAP);
    if (sheets[0]) sheets[0] = { ...sheets[0], columns: pickColumns(sheets[0].columns, body.columns) };

    await logDataDownload({
        userId: user.id,
        role: user.role,
        dataset: dataset.id,
        rowCount,
        ownOnly: run.ownOnly,
        filters: clean,
        fullPhone,
        reason: fullPhone ? body.reason : null,
        format: body.format,
    });

    const common = { "Cache-Control": "no-store", "X-Export-Rows": String(rowCount) };

    if (body.format === "csv") {
        return new Response(buildCsv(sheets[0], fileCtx), {
            headers: { ...common, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"` },
        });
    }
    return new Response(new Uint8Array(await buildXlsx(sheets, fileCtx)), {
        headers: {
            ...common,
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${name}.xlsx"`,
        },
    });
});

const ColumnsBody = z.object({ columns: z.array(z.string().max(80)).max(200) });

export const PUT = withErrorHandler(async (req: Request, context: Ctx) => {
    const opened = await open(context, new URLSearchParams());
    if (!opened) return errorResponse("This download is not available to your role.", 403);
    const { user, dataset } = opened;
    const known = new Set(dataset.sheets[0].columns.map((c) => c.key));
    const columns = ColumnsBody.parse(await req.json()).columns.filter((k) => known.has(k));
    // Every column ticked is the default, so it is stored as "no set".
    await saveColumnSet(user.id, dataset.id, columns.length === known.size ? [] : columns);
    return successResponse({ columns });
});
