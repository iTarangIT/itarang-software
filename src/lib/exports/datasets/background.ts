// Reports › Data downloads — files too large to download at once (tracker
// ID 13): built after the request has been answered, kept on the app server
// for BACKGROUND_LINK_HOURS, and emailed to the person who asked as a link.
//
// The file is NOT put in S3: every S3 write is mirrored to Google Drive
// (E-255), and a file of phone numbers must not be copied there. It sits in the
// server's temp directory instead, and the link is served by
// /api/admin/data-downloads/file/[token], which needs a login AND the same
// user — a forwarded email opens nothing. One app server (PM2) is assumed; a
// second instance would not see the first one's files.
// SERVER ONLY.

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getMailer } from "@/lib/email/mailer";
import { logDataDownload } from "@/lib/exports/downloadLog";

import type { Dataset, RunContext } from "./registry";
import { BACKGROUND_LINK_HOURS, BACKGROUND_ROW_CAP, pickColumns } from "./types";
import { buildCsv, buildXlsx, type FileContext } from "./workbook";

const DIR = path.join(os.tmpdir(), "itarang-data-downloads");
const MAX_AGE_MS = BACKGROUND_LINK_HOURS * 60 * 60 * 1000;
const TOKEN = /^[a-f0-9]{32}$/;
const UUID = /^[0-9a-f-]{36}$/i;

/** `<userId>__<token>__<download name>` — the owner and the name travel in the file name. */
const fileName = (userId: string, token: string, name: string) => `${userId}__${token}__${name}`;

/** Delete files past their 24 hours. Best effort; called on every write and read. */
async function sweep(): Promise<void> {
    try {
        const now = Date.now();
        for (const f of await readdir(DIR)) {
            const p = path.join(DIR, f);
            const s = await stat(p).catch(() => null);
            if (s && now - s.mtimeMs > MAX_AGE_MS) await unlink(p).catch(() => undefined);
        }
    } catch {
        // No directory yet, or a file went away under us.
    }
}

/** The stored file for this token, when it exists, is this user's and is not past its 24 hours. */
export async function readBackgroundFile(userId: string, token: string): Promise<{ name: string; body: Buffer } | null> {
    if (!TOKEN.test(token) || !UUID.test(userId)) return null;
    await sweep();
    const prefix = `${userId}__${token}__`;
    const match = (await readdir(DIR).catch(() => [] as string[])).find((f) => f.startsWith(prefix));
    if (!match) return null;
    return { name: match.slice(prefix.length), body: await readFile(path.join(DIR, match)) };
}

export interface BackgroundJob {
    dataset: Dataset;
    run: RunContext;
    fileCtx: FileContext;
    format: "xlsx" | "csv";
    columns?: string[];
    /** Download name without the extension. */
    name: string;
    /** Where the link points: the app's own origin. */
    baseUrl: string;
    reason?: string | null;
}

/** Build the whole file, keep it, log it, and mail the link. Never throws — a failure is mailed instead. */
export async function prepareAndEmail(job: BackgroundJob): Promise<void> {
    const { dataset, run, fileCtx, format, name } = job;
    const to = run.user.email;
    if (!to) return;
    const from = process.env.MAIL_FROM || process.env.SMTP_USER;
    try {
        const sheets = await dataset.build({ ...run, maxRows: BACKGROUND_ROW_CAP });
        sheets[0] = { ...sheets[0], columns: pickColumns(sheets[0].columns, job.columns) };
        const rowCount = sheets[0].rows.length;
        const body = format === "csv" ? Buffer.from(buildCsv(sheets[0], fileCtx), "utf8") : Buffer.from(await buildXlsx(sheets, fileCtx));

        await mkdir(DIR, { recursive: true });
        await sweep();
        const token = randomBytes(16).toString("hex");
        await writeFile(path.join(DIR, fileName(run.user.id, token, `${name}.${format}`)), body);

        await logDataDownload({
            userId: run.user.id,
            role: run.user.role,
            dataset: dataset.id,
            rowCount,
            ownOnly: run.ownOnly,
            filters: { ...fileCtx.filters, background: "1" },
            fullPhone: fileCtx.fullPhone,
            reason: fileCtx.fullPhone ? job.reason : null,
            format,
        });

        const link = `${job.baseUrl}/api/admin/data-downloads/file/${token}`;
        const rowsText = rowCount.toLocaleString("en-IN");
        await getMailer().sendMail({
            from,
            to: [to],
            subject: `Your ${dataset.label} download is ready`,
            text: `Your ${dataset.label} file (${rowsText} rows) is ready.\n\nDownload: ${link}\n\nThe link works for ${BACKGROUND_LINK_HOURS} hours, and only while you are logged in to the CRM as yourself.`,
            html: `<p>Your <b>${dataset.label}</b> file (${rowsText} rows) is ready.</p><p><a href="${link}">Download the file</a></p><p>The link works for ${BACKGROUND_LINK_HOURS} hours, and only while you are logged in to the CRM as yourself.</p>`,
        });
    } catch (e) {
        console.error("[data-downloads] background file failed:", dataset.id, e);
        await getMailer()
            .sendMail({
                from,
                to: [to],
                subject: `Your ${dataset.label} download could not be prepared`,
                text: `The ${dataset.label} file you asked for could not be prepared: ${(e as Error).message.split("\n")[0]}\n\nTry again with a narrower date range or fewer filters.`,
            })
            .catch(() => undefined);
    }
}
