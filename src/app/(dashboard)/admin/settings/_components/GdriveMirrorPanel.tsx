"use client";

// E-255 — Google Drive backup. Settings (switch, root folder, acting-as user)
// plus the ledger dashboard (how much is backed up, what failed and why) and
// the three levers an admin needs: test the connection, backfill everything
// already in S3, and retry what failed.

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
    AlertTriangle,
    CheckCircle2,
    ExternalLink,
    Link2,
    Loader2,
    RefreshCw,
    Unlink,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Settings = {
    enabled: boolean;
    rootFolderId: string | null;
    impersonateUser: string | null;
};

type Status = {
    counts: Record<"pending" | "uploading" | "done" | "failed" | "source_deleted", number>;
    total: number;
    bytes_done: number;
    last_mirrored_at: string | null;
    recent_failures: Array<{
        id: number;
        bucket: string;
        object_key: string;
        attempts: number;
        next_attempt_at: string;
        last_error: string | null;
    }>;
    recent_done: Array<{
        id: number;
        bucket: string;
        object_key: string;
        mirrored_at: string | null;
        drive_web_view_link: string | null;
    }>;
};

type Payload = {
    settings: Settings;
    credential: { configured: boolean; serviceAccountEmail: string | null };
    storageBackend: "s3" | "supabase";
    layout: Array<{ folder: string; sources: string[]; description: string; included: boolean }>;
    oauth: {
        clientConfigured: boolean;
        redirectUri: string;
        connected: boolean;
        email: string | null;
        connected_at: string | null;
    };
    status: Status | { error: string };
};

type ProbeResult = {
    ok: boolean;
    message: string;
    folder_name?: string;
    acting_as?: string;
};

const QUERY_KEY = ["gdrive-mirror-settings"];

function fmtBytes(n: number): string {
    if (!n) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
    }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtWhen(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

async function api<T>(method: "GET" | "PUT" | "POST", body?: unknown): Promise<T> {
    const res = await fetch("/api/admin/settings/gdrive-mirror", {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? `Request failed (${res.status})`);
    }
    return json.data as T;
}

export function GdriveMirrorPanel() {
    const qc = useQueryClient();
    const router = useRouter();
    const searchParams = useSearchParams();

    // The OAuth round-trip lands back here with ?oauth=<status>. Toast it once
    // and scrub the query string so a refresh does not re-toast.
    useEffect(() => {
        const flag = searchParams.get("oauth");
        if (!flag) return;
        const reason = searchParams.get("reason");
        const email = searchParams.get("email");
        if (flag === "connected") {
            toast.success(
                `Google account connected${email ? ` (${email})` : ""}. Save a root folder and test the connection.`,
            );
        } else if (flag === "not_configured") {
            toast.error("GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not set on this server.");
        } else if (flag === "denied") {
            toast.error(`Google sign-in was cancelled${reason ? ` (${reason})` : ""}.`);
        } else if (flag === "bad_state") {
            toast.error("The sign-in link had expired or was opened by a different user. Try again.");
        } else {
            toast.error(`Could not connect Google account${reason ? `: ${reason}` : ""}.`);
        }
        router.replace("/admin/settings/gdrive-mirror");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const { data, isLoading, error } = useQuery({
        queryKey: QUERY_KEY,
        queryFn: () => api<Payload>("GET"),
        // The ledger moves on its own (ticker); keep the counts fresh while the
        // page is open, more often while there is work in flight.
        refetchInterval: (q) => {
            const s = q.state.data?.status;
            const busy = s && !("error" in s) && (s.counts.pending > 0 || s.counts.uploading > 0);
            return busy ? 5_000 : 30_000;
        },
    });

    const [draft, setDraft] = useState<Settings | null>(null);
    const [saving, setSaving] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [probe, setProbe] = useState<ProbeResult | null>(null);

    useEffect(() => {
        if (data && draft === null) setDraft(data.settings);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data]);

    if (isLoading || !data || !draft) {
        return (
            <div className="flex items-center gap-2 text-sm text-ink-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
        );
    }
    if (error) {
        return (
            <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
                {error instanceof Error ? error.message : "Failed to load"}
            </div>
        );
    }

    const dirty =
        draft.enabled !== data.settings.enabled ||
        (draft.rootFolderId ?? "") !== (data.settings.rootFolderId ?? "") ||
        (draft.impersonateUser ?? "") !== (data.settings.impersonateUser ?? "");

    const status = "error" in data.status ? null : data.status;
    const statusError = "error" in data.status ? data.status.error : null;

    const save = async () => {
        setSaving(true);
        try {
            const next = await api<Payload>("PUT", {
                enabled: draft.enabled,
                rootFolderId: draft.rootFolderId ?? null,
                impersonateUser: draft.impersonateUser ?? null,
            });
            qc.setQueryData(QUERY_KEY, next);
            setDraft(next.settings);
            toast.success(next.settings.enabled ? "Drive backup is ON" : "Drive backup saved (off)");
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Save failed");
        } finally {
            setSaving(false);
        }
    };

    const run = async (
        action: "test" | "backfill" | "process" | "retry_failed" | "disconnect_oauth",
    ) => {
        setBusy(action);
        try {
            const next = await api<Payload & { result: unknown }>("POST", { action });
            qc.setQueryData(QUERY_KEY, next);
            if (action === "test") {
                const r = next.result as ProbeResult;
                setProbe(r);
                (r.ok ? toast.success : toast.error)(r.message);
            } else if (action === "backfill") {
                const r = next.result as { listed: number; enqueued: number };
                toast.success(
                    `Backfill queued ${r.enqueued} new object${r.enqueued === 1 ? "" : "s"} (${r.listed} in S3). The sweep uploads them in the background.`,
                );
            } else if (action === "process") {
                const r = next.result as {
                    skipped_reason: string | null;
                    done: number;
                    failed: number;
                    claimed: number;
                };
                if (r.skipped_reason) toast.error(`Not run: ${r.skipped_reason}`);
                else toast.success(`Uploaded ${r.done}, failed ${r.failed} (of ${r.claimed} claimed).`);
            } else if (action === "disconnect_oauth") {
                toast.success("Google account disconnected. Uploads fall back to the service account.");
            } else {
                const r = next.result as { reset: number };
                toast.success(`${r.reset} failed row${r.reset === 1 ? "" : "s"} queued for retry.`);
            }
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Action failed");
        } finally {
            setBusy(null);
        }
    };

    const rootLink = data.settings.rootFolderId
        ? `https://drive.google.com/drive/folders/${data.settings.rootFolderId}`
        : null;

    return (
        <div className="space-y-6">
            {/* Preconditions */}
            {data.storageBackend !== "s3" && (
                <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                        This host is running with <code>STORAGE_BACKEND={data.storageBackend}</code>.
                        The Drive mirror hooks the S3 write path, so nothing is mirrored here until
                        the backend is <code>s3</code>.
                    </span>
                </div>
            )}
            {!data.credential.configured && !data.oauth.connected && (
                <div className="flex gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-900">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                        No Google service account on this host — set{" "}
                        <code>GOOGLE_SERVICE_ACCOUNT_EMAIL</code> and <code>GOOGLE_PRIVATE_KEY</code>{" "}
                        (the same pair the Sheets export and expense scanner use).
                    </span>
                </div>
            )}

            {/* Settings */}
            <div className="rounded-xl border border-border bg-surface shadow-card">
                <div className="space-y-5 p-5">
                    <div className="rounded-lg border border-border bg-surface-subtle p-4">
                        <label className="flex cursor-pointer items-start gap-3">
                            <input
                                type="checkbox"
                                className="mt-1 h-4 w-4"
                                checked={draft.enabled}
                                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                            />
                            <span>
                                <span className="block text-sm font-medium text-ink">
                                    Back up every stored document to Google Drive
                                </span>
                                <span className="mt-0.5 block text-xs text-ink-muted">
                                    Off by default. While off, uploads are still recorded in the
                                    backup ledger, so nothing is missed — they are simply not copied
                                    until you turn this on. Turning it on never changes what the CRM
                                    serves: S3 stays the primary store; Drive is the copy.
                                </span>
                            </span>
                        </label>
                    </div>

                    <div className="space-y-2">
                        <label className="block text-sm font-medium text-ink">
                            Root folder in Google Drive
                        </label>
                        <p className="text-xs text-ink-muted">
                            Paste the folder&apos;s URL or id. The backup creates its own category
                            folders inside it — <em>KYC Documents</em>, <em>Dealer Onboarding</em>,{" "}
                            <em>Dealer Agreements</em>, <em>NBFC</em>… (full list, and what is
                            <strong>not</strong> backed up, below) — so pick an empty folder such as &ldquo;iTarang CRM
                            Backup&rdquo;. The folder must be shared with{" "}
                            <code>{data.credential.serviceAccountEmail ?? "the service account"}</code>{" "}
                            as Editor, or belong to the user named below.
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                            <Input
                                className="w-full max-w-xl"
                                placeholder="https://drive.google.com/drive/folders/…"
                                value={draft.rootFolderId ?? ""}
                                onChange={(e) =>
                                    setDraft({ ...draft, rootFolderId: e.target.value || null })
                                }
                            />
                            {rootLink && (
                                <a
                                    href={rootLink}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 text-xs text-brand-navy underline"
                                >
                                    Open in Drive <ExternalLink className="h-3 w-3" />
                                </a>
                            )}
                        </div>
                    </div>

                    <div className="space-y-2 rounded-lg border border-border bg-surface-subtle p-4">
                        <label className="block text-sm font-medium text-ink">Google account</label>
                        {data.oauth.connected ? (
                            <>
                                <p className="flex flex-wrap items-center gap-2 text-xs text-emerald-800">
                                    <CheckCircle2 className="h-4 w-4" />
                                    Connected as <strong>{data.oauth.email ?? "a Google account"}</strong>
                                    {data.oauth.connected_at && (
                                        <span className="text-ink-muted">
                                            since {fmtWhen(data.oauth.connected_at)}
                                        </span>
                                    )}
                                </p>
                                <p className="text-xs text-ink-muted">
                                    Every backup file is created by this account and stored in its Drive.
                                    The root folder above must be one this account can edit (a folder in
                                    its own My Drive is simplest). The service account / &ldquo;Act
                                    as&rdquo; settings below are ignored while an account is connected.
                                </p>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => run("disconnect_oauth")}
                                    disabled={busy !== null}
                                >
                                    {busy === "disconnect_oauth" ? (
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    ) : (
                                        <Unlink className="mr-2 h-4 w-4" />
                                    )}
                                    Disconnect
                                </Button>
                            </>
                        ) : (
                            <>
                                <p className="text-xs text-ink-muted">
                                    <strong>Easiest option.</strong> Sign in once as the Workspace user who
                                    should own the backup (e.g. <code>it@itarang.com</code>) and grant
                                    Drive access. No Admin-console / domain-wide-delegation step is
                                    needed; the files are created as that user in their My Drive.
                                    {!data.oauth.clientConfigured && (
                                        <>
                                            {" "}
                                            Not available yet on this server: set{" "}
                                            <code>GOOGLE_OAUTH_CLIENT_ID</code> /{" "}
                                            <code>GOOGLE_OAUTH_CLIENT_SECRET</code> from a Web-application
                                            OAuth client whose redirect URI is{" "}
                                            <code className="break-all">{data.oauth.redirectUri}</code>.
                                        </>
                                    )}
                                </p>
                                <Button
                                    size="sm"
                                    onClick={() => {
                                        window.location.href =
                                            "/api/admin/settings/gdrive-mirror/oauth/start";
                                    }}
                                    disabled={!data.oauth.clientConfigured || busy !== null}
                                >
                                    <Link2 className="mr-2 h-4 w-4" />
                                    Connect Google account
                                </Button>
                            </>
                        )}
                    </div>

                    <div className="space-y-2">
                        <label className="block text-sm font-medium text-ink">
                            Act as Workspace user{" "}
                            <span className="font-normal text-ink-muted">
                                (optional — service-account path only)
                            </span>
                        </label>
                        <p className="text-xs text-ink-muted">
                            A service account has no Drive storage of its own, so it can only
                            upload into a <strong>Shared Drive</strong> it is a member of. To back
                            up into a normal &ldquo;My Drive&rdquo; folder instead, enter the email of
                            the Workspace user who owns that folder — files are then created as that
                            user and use their storage. This needs domain-wide delegation for the
                            service account&apos;s client id in the Google Admin console (scope{" "}
                            <code>https://www.googleapis.com/auth/drive</code>).
                        </p>
                        <Input
                            className="w-full max-w-md"
                            placeholder="it@itarang.com"
                            value={draft.impersonateUser ?? ""}
                            onChange={(e) =>
                                setDraft({ ...draft, impersonateUser: e.target.value || null })
                            }
                        />
                    </div>

                    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
                        <Button onClick={save} disabled={!dirty || saving}>
                            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Save
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() => run("test")}
                            disabled={busy !== null || dirty || !data.settings.rootFolderId}
                            title={dirty ? "Save first" : undefined}
                        >
                            {busy === "test" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Test connection
                        </Button>
                        {probe && (
                            <span
                                className={`inline-flex items-center gap-1 text-xs ${
                                    probe.ok ? "text-emerald-700" : "text-red-700"
                                }`}
                            >
                                {probe.ok ? (
                                    <CheckCircle2 className="h-4 w-4" />
                                ) : (
                                    <AlertTriangle className="h-4 w-4" />
                                )}
                                {probe.message}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* Layout */}
            <div className="rounded-xl border border-border bg-surface shadow-card">
                <div className="space-y-3 p-5">
                    <h2 className="text-base font-semibold text-ink">How files are organised in Drive</h2>
                    <p className="text-xs text-ink-muted">
                        Each S3 object is filed under a category folder chosen from where the CRM
                        stored it; the rest of its path (the lead, dealer or NBFC it belongs to)
                        is kept as sub-folders. Anything that matches no rule goes to{" "}
                        <code>Other/&lt;bucket&gt;/…</code> — nothing is skipped.
                    </p>
                    <div className="overflow-x-auto rounded-md border border-border">
                        <table className="w-full text-xs">
                            <thead className="bg-surface-subtle text-left text-ink-muted">
                                <tr>
                                    <th className="px-3 py-2">Drive folder</th>
                                    <th className="px-3 py-2">Backed up?</th>
                                    <th className="px-3 py-2">What goes there</th>
                                    <th className="px-3 py-2">S3 source</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.layout.map((l) => (
                                    <tr
                                        key={l.folder}
                                        className={`border-t border-border align-top ${l.included ? "" : "text-ink-muted"}`}
                                    >
                                        <td className="whitespace-nowrap px-3 py-2 font-medium text-ink">
                                            {l.folder}
                                        </td>
                                        <td className="whitespace-nowrap px-3 py-2">
                                            {l.included ? (
                                                <span className="text-emerald-700">Yes</span>
                                            ) : (
                                                <span>No — not backed up</span>
                                            )}
                                        </td>
                                        <td className="px-3 py-2">{l.description}</td>
                                        <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">
                                            {l.sources.join(", ")}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            {/* Ledger */}
            <div className="rounded-xl border border-border bg-surface shadow-card">
                <div className="space-y-4 p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="text-base font-semibold text-ink">Backup status</h2>
                        <div className="flex flex-wrap gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => run("backfill")}
                                disabled={busy !== null || data.storageBackend !== "s3"}
                                title="List every object in S3 and queue any that has no backup row yet"
                            >
                                {busy === "backfill" ? (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                    <RefreshCw className="mr-2 h-4 w-4" />
                                )}
                                Backfill everything in S3
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => run("process")}
                                disabled={busy !== null || !data.settings.enabled}
                                title="Upload the next batch now instead of waiting for the sweep"
                            >
                                {busy === "process" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                Upload next batch now
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => run("retry_failed")}
                                disabled={busy !== null || !status || status.counts.failed === 0}
                            >
                                {busy === "retry_failed" && (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                )}
                                Retry failed now
                            </Button>
                        </div>
                    </div>

                    {statusError ? (
                        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-900">
                            Could not read the backup ledger: {statusError}. If this says the
                            relation does not exist, migration <code>E-255</code> has not been applied
                            to this database.
                        </div>
                    ) : status ? (
                        <>
                            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                                <Stat label="Backed up" value={status.counts.done} tone="ok" />
                                <Stat label="Waiting" value={status.counts.pending} />
                                <Stat label="Uploading" value={status.counts.uploading} />
                                <Stat
                                    label="Failed"
                                    value={status.counts.failed}
                                    tone={status.counts.failed ? "bad" : undefined}
                                />
                                <Stat label="Deleted in S3" value={status.counts.source_deleted} />
                                <Stat label="Size in Drive" value={fmtBytes(status.bytes_done)} />
                            </div>
                            <p className="text-xs text-ink-muted">
                                Last file backed up: {fmtWhen(status.last_mirrored_at)}. The sweep runs
                                every minute and re-scans S3 for anything missed every six hours.
                            </p>

                            {status.recent_failures.length > 0 && (
                                <div className="space-y-2">
                                    <h3 className="text-sm font-medium text-ink">Recent failures</h3>
                                    <div className="overflow-x-auto rounded-md border border-border">
                                        <table className="w-full text-xs">
                                            <thead className="bg-surface-subtle text-left text-ink-muted">
                                                <tr>
                                                    <th className="px-3 py-2">Object</th>
                                                    <th className="px-3 py-2">Attempts</th>
                                                    <th className="px-3 py-2">Next try</th>
                                                    <th className="px-3 py-2">Error</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {status.recent_failures.map((f) => (
                                                    <tr key={f.id} className="border-t border-border align-top">
                                                        <td className="max-w-[320px] break-all px-3 py-2 font-mono">
                                                            {f.bucket}/{f.object_key}
                                                        </td>
                                                        <td className="px-3 py-2">{f.attempts}</td>
                                                        <td className="whitespace-nowrap px-3 py-2">
                                                            {fmtWhen(f.next_attempt_at)}
                                                        </td>
                                                        <td className="max-w-[420px] px-3 py-2 text-red-800">
                                                            {f.last_error ?? "—"}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            )}

                            {status.recent_done.length > 0 && (
                                <div className="space-y-2">
                                    <h3 className="text-sm font-medium text-ink">Recently backed up</h3>
                                    <ul className="space-y-1 text-xs">
                                        {status.recent_done.map((d) => (
                                            <li key={d.id} className="flex flex-wrap items-center gap-2">
                                                <span className="break-all font-mono">
                                                    {d.bucket}/{d.object_key}
                                                </span>
                                                <span className="text-ink-muted">{fmtWhen(d.mirrored_at)}</span>
                                                {d.drive_web_view_link && (
                                                    <a
                                                        href={d.drive_web_view_link}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="inline-flex items-center gap-1 text-brand-navy underline"
                                                    >
                                                        Open <ExternalLink className="h-3 w-3" />
                                                    </a>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

function Stat({
    label,
    value,
    tone,
}: {
    label: string;
    value: number | string;
    tone?: "ok" | "bad";
}) {
    const color =
        tone === "ok" ? "text-emerald-700" : tone === "bad" ? "text-red-700" : "text-ink";
    return (
        <div className="rounded-lg border border-border bg-surface-subtle p-3">
            <div className="text-[11px] uppercase tracking-wide text-ink-muted">{label}</div>
            <div className={`mt-1 text-xl font-semibold tabular-nums ${color}`}>{value}</div>
        </div>
    );
}
