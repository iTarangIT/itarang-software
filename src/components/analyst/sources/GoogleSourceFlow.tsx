"use client";

// Data Analyst — adding a Google Sheet, Drive file or Drive folder to a dataset. Ported from
// the agent's own frontend (components/connections/google-source.tsx), same rules:
//   1. make an empty dataset, 2. resolve the link — the agent may ask for it to be shared with
//   its Google service account, or (if no one in the org shared it) for a confirm,
//   3. pick tabs / files / folders, 4. save the rules; the agent then syncs on its own.
// The agent reads Google through ONE service account, not the user's own Google login.

import { ChevronRight, Copy, FileSpreadsheet, Folder, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import type { DriveListing, DriveNode, DryRun, Source, SourceRule } from "@/lib/analyst/types";
import { cn } from "@/lib/utils";

import { formatBytes, sourcesApi } from "./api";

type Step =
  | { step: "link" }
  | { step: "checking" }
  | { step: "needs_share"; shareWith: string }
  | { step: "unverified" }
  | { step: "pick"; source: Source };

const ORIGIN_LABEL: Record<Source["origin"], string> = {
  upload: "Uploaded files",
  gdrive_folder: "Drive folder",
  gdrive_file: "Drive file",
  gsheet: "Google Sheet",
};

function ruleFor(origin: Source["origin"], node: DriveNode): SourceRule {
  if (origin === "gsheet") return { id: node.id, kind: "sheet", recursive: false };
  return { id: node.id, kind: node.kind === "folder" ? "folder" : "file", recursive: false };
}

export function GoogleSourceFlow({
  onDone,
  onDatasetCreated,
  existingConnectionId,
}: {
  /** Called with the dataset's id once the source is saved. */
  onDone: (connectionId: string) => void;
  /** So the caller can delete an empty dataset if the flow is abandoned. */
  onDatasetCreated?: (connectionId: string) => void;
  /** Add to this dataset instead of creating one. */
  existingConnectionId?: string;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [datasetId, setDatasetId] = useState<string | null>(existingConnectionId ?? null);
  const [step, setStep] = useState<Step>({ step: "link" });
  const [error, setError] = useState<string | null>(null);

  // Folder browsing: a breadcrumb of folders, the listing of the last one.
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  const [listing, setListing] = useState<DriveListing | null>(null);
  const [chosen, setChosen] = useState<SourceRule[]>([]);
  const [recursive, setRecursive] = useState(true);
  const [combine, setCombine] = useState(true);
  const [estimate, setEstimate] = useState<DryRun | null>(null);
  const [saving, setSaving] = useState(false);

  const source = step.step === "pick" ? step.source : null;
  const rules = useMemo(
    () => chosen.map((r) => ({ ...r, recursive: r.kind === "folder" && recursive })),
    [chosen, recursive],
  );

  async function resolve(confirm: boolean) {
    setError(null);
    setStep({ step: "checking" });
    try {
      let id = datasetId;
      if (!id) {
        id = (await sourcesApi.createDataset(name.trim())).id;
        setDatasetId(id);
        onDatasetCreated?.(id);
      }
      const result = await sourcesApi.resolveGoogle(id, url.trim(), confirm);
      if (result.status === "needs_share" && result.share_with) {
        setStep({ step: "needs_share", shareWith: result.share_with });
      } else if (result.status === "unverified") {
        setStep({ step: "unverified" });
      } else if (result.status === "resolved" && result.source) {
        const found = result.source;
        setChosen(found.rules);
        setCombine(found.combine);
        if (found.origin !== "gdrive_file") {
          const root = await sourcesApi.driveTree(id, found.id);
          setListing(root);
          setTrail([{ id: root.folder_id, name: found.label }]);
        }
        setStep({ step: "pick", source: found });
      } else {
        throw new Error("That link could not be checked. Try again.");
      }
    } catch (e) {
      setError((e as Error).message);
      setStep({ step: "link" });
    }
  }

  async function openFolder(folder: { id: string; name: string }, depth: number) {
    if (!source || !datasetId) return;
    try {
      const next = await sourcesApi.driveTree(datasetId, source.id, folder.id);
      setListing(next);
      setTrail((t) => [...t.slice(0, depth), folder]);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  // A live size estimate for folder picks, so the 100 MB dataset cap is seen before saving.
  useEffect(() => {
    if (!datasetId || source?.origin !== "gdrive_folder" || rules.length === 0) {
      setEstimate(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      sourcesApi
        .dryRun(datasetId, { source_id: source.id, rules, combine })
        .then((run) => live && setEstimate(run))
        .catch(() => live && setEstimate(null));
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [datasetId, source, rules, combine]);

  async function save() {
    if (!source || !datasetId) return;
    setSaving(true);
    try {
      const saved = await sourcesApi.chooseSource(datasetId, { source_id: source.id, rules, combine });
      toast.success(`Added ${saved.label}. Its files are being read now.`);
      onDone(datasetId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const ancestors = trail.map((t) => t.id);
  const folderIds = new Set(rules.filter((r) => r.kind === "folder").map((r) => r.id));
  const covered = (node: DriveNode) =>
    recursive
      ? ancestors.some((id) => folderIds.has(id))
      : node.kind !== "folder" && folderIds.has(ancestors[ancestors.length - 1] ?? "");

  function toggle(node: DriveNode) {
    if (!source) return;
    const rule = ruleFor(source.origin, node);
    setChosen((current) =>
      current.some((r) => r.id === rule.id) ? current.filter((r) => r.id !== rule.id) : [...current, rule],
    );
  }

  if (step.step === "pick" && source) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          {source.origin === "gdrive_folder" ? (
            <Folder aria-hidden className="size-4 text-ink-muted" />
          ) : (
            <FileSpreadsheet aria-hidden className="size-4 text-success" />
          )}
          <div className="min-w-0">
            <p className="truncate text-[0.875rem] font-medium text-ink">{source.label}</p>
            <p className="text-[0.75rem] text-ink-muted">{ORIGIN_LABEL[source.origin]}</p>
          </div>
        </div>

        {source.origin === "gdrive_file" ? (
          <p className="text-[0.8125rem] text-ink-muted">
            This file becomes one or more tables once it is read, and is read again whenever it changes in Drive.
          </p>
        ) : listing ? (
          <>
            <p className="text-[0.8125rem] text-ink-muted">
              {source.origin === "gsheet"
                ? "Tick the tabs to read. Each one becomes a table."
                : "Tick the folders and files to read. Open a folder to look inside."}
            </p>
            {source.origin === "gdrive_folder" && trail.length > 1 ? (
              <nav className="flex flex-wrap items-center gap-1 text-[0.75rem] text-ink-muted">
                {trail.map((t, i) => (
                  <span key={t.id} className="flex items-center gap-1">
                    {i > 0 ? <ChevronRight aria-hidden className="size-3" /> : null}
                    <button type="button" onClick={() => openFolder(t, i)} className="hover:text-ink hover:underline">
                      {t.name}
                    </button>
                  </span>
                ))}
              </nav>
            ) : null}
            <ul className="flex max-h-72 flex-col overflow-y-auto rounded-lg border border-border p-1">
              {listing.children.map((node) => {
                const isCovered = covered(node);
                const checked = isCovered || chosen.some((r) => r.id === node.id);
                const locked = saving || !node.supported || isCovered;
                return (
                  <li key={node.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-bg">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={locked}
                      onChange={() => toggle(node)}
                      aria-label={`Read ${node.name}`}
                      className="size-4 accent-brand-500"
                    />
                    {node.kind === "folder" ? (
                      <button
                        type="button"
                        onClick={() => openFolder({ id: node.id, name: node.name }, trail.length)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      >
                        <Folder aria-hidden className="size-3.5 shrink-0 text-ink-muted" />
                        <span className="truncate text-[0.8125rem] text-ink">{node.name}</span>
                        <ChevronRight aria-hidden className="ml-auto size-3.5 shrink-0 text-ink-muted" />
                      </button>
                    ) : (
                      <span className="flex min-w-0 flex-1 items-center gap-1.5">
                        <FileSpreadsheet aria-hidden className="size-3.5 shrink-0 text-ink-muted" />
                        <span className={cn("truncate text-[0.8125rem]", node.supported ? "text-ink" : "text-ink-muted")}>
                          {node.name}
                        </span>
                        <span className="ml-auto shrink-0 text-[0.6875rem] text-ink-muted">
                          {node.supported ? formatBytes(node.bytes) : "not supported"}
                        </span>
                      </span>
                    )}
                  </li>
                );
              })}
              {listing.children.length === 0 ? (
                <li className="px-3 py-4 text-center text-[0.8125rem] text-ink-muted">Nothing to read here.</li>
              ) : null}
            </ul>
            {source.origin === "gdrive_folder" ? (
              <label className="flex items-center gap-2 text-[0.8125rem] text-ink">
                <input
                  type="checkbox"
                  checked={recursive}
                  onChange={(e) => setRecursive(e.target.checked)}
                  className="size-4 accent-brand-500"
                />
                Include folders inside chosen folders
              </label>
            ) : null}
            <label className="flex items-center gap-2 text-[0.8125rem] text-ink">
              <input
                type="checkbox"
                checked={combine}
                onChange={(e) => setCombine(e.target.checked)}
                className="size-4 accent-brand-500"
              />
              Combine {source.origin === "gsheet" ? "tabs" : "files"} with the same columns into one table
            </label>
            {estimate ? (
              <p className={cn("text-[0.75rem]", estimate.fits ? "text-ink-muted" : "text-danger")}>
                {estimate.files} file{estimate.files === 1 ? "" : "s"}, {formatBytes(estimate.bytes)} of{" "}
                {formatBytes(estimate.limit)}
                {estimate.fits ? "" : " — too large, choose less"}
                {estimate.skipped.length ? ` · ${estimate.skipped.length} skipped` : ""}
              </p>
            ) : null}
          </>
        ) : null}

        {error ? <p className="text-[0.8125rem] text-danger">{error}</p> : null}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={save}
            disabled={saving || rules.length === 0 || estimate?.fits === false}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-[0.8125rem] font-medium text-white hover:bg-brand-600 disabled:opacity-60"
          >
            {saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
            Add source
          </button>
        </div>
      </div>
    );
  }

  const checking = step.step === "checking";
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!datasetId && !name.trim()) return setError("Name this dataset.");
        if (!url.trim()) return setError("Paste a Google Drive or Google Sheets link.");
        void resolve(false);
      }}
    >
      {datasetId ? null : (
        <Field label="Dataset name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Monthly sales sheet"
            maxLength={200}
            className={INPUT}
          />
        </Field>
      )}
      <Field label="Google Sheets or Drive link">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://docs.google.com/spreadsheets/d/…"
          className={INPUT}
        />
      </Field>

      {step.step === "needs_share" ? (
        <div className="rounded-lg border border-warning/30 bg-warning-bg px-3 py-2.5 text-[0.8125rem] text-ink">
          <p>
            The analyst can&rsquo;t open this yet. In Google, share it (Viewer is enough) with:
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 text-[0.75rem]">{step.shareWith}</code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(step.shareWith);
                toast.success("Copied");
              }}
              className="rounded p-1 text-ink-muted hover:bg-surface hover:text-ink"
              aria-label="Copy the email"
            >
              <Copy aria-hidden className="size-3.5" />
            </button>
          </div>
          <p className="mt-1.5 text-ink-muted">Then check again.</p>
        </div>
      ) : null}

      {step.step === "unverified" ? (
        <div className="rounded-lg border border-warning/30 bg-warning-bg px-3 py-2.5 text-[0.8125rem] text-ink">
          <p>This was not shared by anyone in your organisation. Only use it if you trust where it came from.</p>
          <button
            type="button"
            onClick={() => void resolve(true)}
            className="mt-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-[0.8125rem] font-medium hover:bg-bg"
          >
            Use it anyway
          </button>
        </div>
      ) : null}

      {error ? <p className="text-[0.8125rem] text-danger">{error}</p> : null}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={checking}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-[0.8125rem] font-medium text-white hover:bg-brand-600 disabled:opacity-60"
        >
          {checking ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
          {step.step === "needs_share" ? "Check again" : "Connect"}
        </button>
      </div>
    </form>
  );
}

export const INPUT =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-[0.8125rem] text-ink outline-none focus:ring-2 focus:ring-brand-100";

export function Field({ label, children, error }: { label: string; children: React.ReactNode; error?: string | null }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[0.75rem] font-medium text-ink-muted">{label}</span>
      {children}
      {error ? <span className="text-[0.75rem] text-danger">{error}</span> : null}
    </label>
  );
}
