"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { LI_CATEGORIES, UNCATEGORISED } from "@/lib/linkedin/categories";

import { json, liFetch } from "./api";
import { LI_BASE } from "./LinkedInTabs";

const FIELDS = ["first_name", "company", "headline", "city"] as const;
const NOTE_MAX = 300;

type Account = { id: string; label: string; status: string; provider_account_id: string | null };
type PreviewRow = {
  campaign_prospect_id: string;
  prospect_id: string;
  full_name: string | null;
  company: string | null;
  public_url: string;
  state: string;
  message: string;
  note: string | null;
  blocked: string | null;
};
type Campaign = {
  id: string;
  name: string;
  account_id: string;
  template: string;
  invite_note: string | null;
  attachment_id: string | null;
  status: string;
  category?: string;
};

export function CampaignComposer({ initialProspectIds, campaignId }: { initialProspectIds: string[]; campaignId: string | null }) {
  const router = useRouter();
  const [id, setId] = useState<string | null>(campaignId);
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [category, setCategory] = useState("");
  const [template, setTemplate] = useState("Hi {{first_name}}, ");
  const [note, setNote] = useState("");
  const [attachment, setAttachment] = useState<{ id: string; file_name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [dirty, setDirty] = useState(true);
  const tplRef = useRef<HTMLTextAreaElement>(null);

  const accounts = useQuery({
    queryKey: ["li-accounts"],
    queryFn: () => liFetch<{ accounts: Account[] }>("/api/linkedin/accounts"),
  });
  useEffect(() => {
    if (!accountId && accounts.data?.accounts[0]) setAccountId(accounts.data.accounts[0].id);
  }, [accounts.data, accountId]);

  // Editing an existing draft.
  const existing = useQuery({
    queryKey: ["li-campaign-edit", campaignId],
    enabled: !!campaignId,
    queryFn: () => liFetch<{ campaign: Campaign; attachment: { id: string; file_name: string } | null }>(`/api/linkedin/campaigns/${campaignId}`),
  });
  useEffect(() => {
    const c = existing.data?.campaign;
    if (!c) return;
    setName(c.name);
    setAccountId(c.account_id);
    setCategory(c.category && c.category !== UNCATEGORISED ? c.category : "");
    setTemplate(c.template);
    setNote(c.invite_note ?? "");
    setAttachment(existing.data?.attachment ?? null);
    setDirty(false);
  }, [existing.data]);

  const preview = useQuery({
    queryKey: ["li-preview", id],
    enabled: !!id && !dirty,
    queryFn: () => liFetch<{ campaign: Campaign; rows: PreviewRow[] }>(`/api/linkedin/campaigns/${id}/preview`),
  });

  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
  };

  function insertField(f: string) {
    const el = tplRef.current;
    const token = `{{${f}}}`;
    if (!el) return edit(setTemplate)(template + token);
    const start = el.selectionStart ?? template.length;
    const end = el.selectionEnd ?? template.length;
    edit(setTemplate)(template.slice(0, start) + token + template.slice(end));
  }

  async function upload(file: File) {
    const fd = new FormData();
    fd.set("file", file);
    try {
      const a = await liFetch<{ id: string; file_name: string }>("/api/linkedin/attachments", { method: "POST", body: fd });
      edit(setAttachment)(a);
      toast.success("Attachment uploaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    }
  }

  async function save() {
    if (!accountId) return toast.error("Add a LinkedIn account first (Accounts tab)");
    if (!category) return toast.error("Pick a category (3 Wheeler, 2 Wheeler, FinTech…) so the campaign shows up in Analytics");
    setSaving(true);
    try {
      const body = {
        name: name || "LinkedIn campaign",
        template,
        invite_note: note || null,
        attachment_id: attachment?.id ?? null,
        category,
      };
      if (id) {
        await liFetch(`/api/linkedin/campaigns/${id}`, { method: "PATCH", ...json(body) });
      } else {
        const c = await liFetch<Campaign>("/api/linkedin/campaigns", {
          method: "POST",
          ...json({ ...body, account_id: accountId, prospect_ids: initialProspectIds }),
        });
        setId(c.id);
        router.replace(`${LI_BASE}/campaigns/new?campaign=${c.id}`);
      }
      setDirty(false);
      await preview.refetch();
      toast.success("Draft saved — review the preview, then approve");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function approve() {
    if (!id) return;
    setApproving(true);
    try {
      const r = await liFetch<{ queued: number; skipped: number }>(`/api/linkedin/campaigns/${id}/approve`, { method: "POST" });
      toast.success(`Approved: ${r.queued} queued${r.skipped ? `, ${r.skipped} left out` : ""}`);
      router.push(`${LI_BASE}/campaigns/${id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setApproving(false);
    }
  }

  const rows = preview.data?.rows ?? [];
  const sendable = rows.filter((r) => !r.blocked).length;
  const status = existing.data?.campaign.status ?? preview.data?.campaign.status ?? "draft";

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(380px,1fr)_1.3fr]">
      <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-gray-900">{id ? "Edit campaign" : "New campaign"}</h2>
        {!id && (
          <p className="text-sm text-gray-600">
            {initialProspectIds.length} prospect{initialProspectIds.length === 1 ? "" : "s"} selected.
          </p>
        )}
        {status !== "draft" && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            This campaign is {status}. Changing the message, note or attachment voids its approval and returns it to draft.
          </p>
        )}
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">Name</span>
          <input value={name} onChange={(e) => edit(setName)(e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">Category</span>
          <select value={category} onChange={(e) => edit(setCategory)(e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2">
            <option value="">Pick a category…</option>
            {LI_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <span className="text-xs text-gray-500">Groups the campaign on the Analytics tab. Changing it never affects the approval.</span>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">Send from</span>
          <select
            value={accountId}
            disabled={!!id}
            onChange={(e) => setAccountId(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2"
          >
            {(accounts.data?.accounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.label} ({a.provider_account_id ? a.status : "not connected"})
              </option>
            ))}
          </select>
          {accounts.data?.accounts.length === 0 && <span className="text-xs text-red-600">No account yet — add one on the Accounts tab.</span>}
        </label>
        <div className="text-sm">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-medium text-gray-700">Message (sent once connected)</span>
            <div className="flex gap-1">
              {FIELDS.map((f) => (
                <button key={f} type="button" onClick={() => insertField(f)} className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-200">
                  {`{{${f}}}`}
                </button>
              ))}
            </div>
          </div>
          <textarea
            ref={tplRef}
            value={template}
            onChange={(e) => edit(setTemplate)(e.target.value)}
            rows={7}
            className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm"
          />
        </div>
        <label className="block text-sm">
          <span className="mb-1 flex justify-between font-medium text-gray-700">
            <span>Invite note (for people not yet connected)</span>
            <span className={note.length > NOTE_MAX ? "text-red-600" : "text-gray-500"}>
              {note.length}/{NOTE_MAX}
            </span>
          </span>
          <textarea value={note} onChange={(e) => edit(setNote)(e.target.value)} rows={3} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          <span className="text-xs text-gray-500">Merge fields work here too. Leave empty to send the invite without a note.</span>
        </label>
        <div className="text-sm">
          <span className="mb-1 block font-medium text-gray-700">Attachment</span>
          {attachment ? (
            <div className="flex items-center gap-3">
              <span className="text-gray-800">{attachment.file_name}</span>
              <button type="button" onClick={() => edit(setAttachment)(null)} className="text-xs text-red-600 hover:underline">
                Remove
              </button>
            </div>
          ) : (
            <input type="file" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} className="text-sm" />
          )}
        </div>
        <div className="flex gap-2 pt-2">
          <button onClick={save} disabled={saving || note.length > NOTE_MAX} className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium disabled:opacity-50">
            {saving ? "Saving…" : "Save & preview"}
          </button>
          <button
            onClick={approve}
            disabled={!id || dirty || approving || !sendable || status !== "draft"}
            className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            title={dirty ? "Save first so the preview matches what you approve" : undefined}
          >
            {approving ? "Approving…" : `Approve & queue ${sendable || ""}`}
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Approving freezes every message below. The worker sends at a safe pace (caps on the Accounts tab); not-connected prospects get an invite first and the message only after they accept.
        </p>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-800">Preview of every message</h2>
          {rows.length > 0 && (
            <span className="text-xs text-gray-500">
              {sendable} will send · {rows.length - sendable} flagged
            </span>
          )}
        </div>
        {dirty && <p className="px-4 py-6 text-sm text-gray-500">Save to see the rendered message for each prospect.</p>}
        {!dirty && preview.isError && <p className="px-4 py-6 text-sm text-red-600">{(preview.error as Error).message}</p>}
        <ul className="max-h-[720px] divide-y divide-gray-100 overflow-y-auto">
          {!dirty &&
            rows.map((r) => (
              <li key={r.campaign_prospect_id} className={`px-4 py-3 ${r.blocked ? "bg-red-50/50" : ""}`}>
                <div className="flex items-center justify-between">
                  <a href={r.public_url} target="_blank" rel="noreferrer" className="text-sm font-medium text-blue-700 hover:underline">
                    {r.full_name ?? r.public_url}
                    {r.company ? <span className="text-gray-500"> · {r.company}</span> : null}
                  </a>
                  {r.blocked ? <span className="text-xs font-medium text-red-700">Not sent: {r.blocked}</span> : <span className="text-xs text-green-700">OK</span>}
                </div>
                {r.note && <p className="mt-1 text-xs text-gray-500">Invite note: {r.note}</p>}
                <p className="mt-1 whitespace-pre-wrap text-sm text-gray-800">{r.message || <em className="text-gray-400">empty</em>}</p>
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}
