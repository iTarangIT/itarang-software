"use client";

// Settings → Quotation CC (E-297). The fixed list of internal addresses CC'd on
// every approved quotation emailed to a dealer, in addition to the lead's
// current owner and whoever presses Send (B4 replaced the quote approver).

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { isPlausibleEmail } from "@/lib/leads/quotationCcRules";

type Payload = {
  settings: {
    emails: string[];
    updated_by_name: string | null;
    updated_at: string | null;
  };
  max: number;
  can_edit: boolean;
};

const QUERY_KEY = ["quotation-cc-settings"];

export function QuotationCcForm() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/admin/settings/quotation-cc");
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Failed to load Quotation CC settings");
      }
      return json.data as Payload;
    },
  });

  const saved = data?.settings.emails ?? [];
  const emails = draft ?? saved;
  const dirty =
    draft !== null &&
    (draft.length !== saved.length || draft.some((e, i) => e !== saved[i]));
  const canEdit = !!data?.can_edit;

  function add() {
    const tokens = input.split(/[\s,;]+/).filter(Boolean);
    if (!tokens.length) return;
    const bad = tokens.filter((t) => !isPlausibleEmail(t));
    if (bad.length) {
      toast.error(`Not a valid email: ${bad.join(", ")}`);
      return;
    }
    const next = [...emails];
    for (const t of tokens) {
      if (!next.some((e) => e.toLowerCase() === t.toLowerCase())) next.push(t);
    }
    if (data && next.length > data.max) {
      toast.error(`At most ${data.max} addresses.`);
      return;
    }
    setDraft(next);
    setInput("");
  }

  function remove(email: string) {
    setDraft(emails.filter((e) => e !== email));
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings/quotation-cc", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Save failed");
      }
      setDraft(null);
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success("Saved. New quotation emails will use this CC list.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-ink-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading Quotation CC settings…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="py-8 text-sm text-red-600">
        {error instanceof Error ? error.message : "Failed to load Quotation CC settings"}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-ink">Quotation CC</h3>
        <p className="mt-1 text-xs text-ink-muted">
          When an approved quotation is emailed to a dealer, it is automatically CC&apos;d
          to the lead&apos;s current owner and the person sending it. The
          addresses below are CC&apos;d on <strong>every</strong> quotation email as well.
          Duplicates, inactive users and the dealer&apos;s own address are skipped.
        </p>
      </div>

      <div className="space-y-2">
        {emails.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-ink-muted">
            No fixed CC addresses.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {emails.map((email) => (
              <li
                key={email}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-subtle px-3 py-1 text-xs text-ink"
              >
                {email}
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => remove(email)}
                    className="text-ink-muted hover:text-red-600"
                    aria-label={`Remove ${email}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {canEdit ? (
        <>
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder="accounts@itarang.com, ops@itarang.com"
              className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand-teal"
            />
            <Button type="button" variant="outline" onClick={add} disabled={!input.trim()}>
              <Plus className="mr-1 h-4 w-4" />
              Add
            </Button>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={!dirty || saving}>
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
            {dirty && (
              <button
                type="button"
                className="text-sm text-ink-muted hover:text-ink"
                onClick={() => setDraft(null)}
              >
                Discard
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="text-xs text-ink-muted">Only admin, CEO or sales head can change this list.</p>
      )}

      {data.settings.updated_at && (
        <p className="text-[11px] text-ink-muted">
          Last changed {new Date(data.settings.updated_at).toLocaleString("en-IN")}
          {data.settings.updated_by_name ? ` by ${data.settings.updated_by_name}` : ""}
        </p>
      )}
    </div>
  );
}
