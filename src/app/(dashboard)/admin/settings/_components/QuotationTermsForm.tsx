"use client";

// Settings → Quotation terms (E-322, tracker ID 73). The standard warranty and
// delivery terms printed on every quotation. Reps cannot change them on a
// quote; Admin and CEO set them here.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

type Payload = {
  settings: {
    warranty: string;
    delivery: string;
    updated_by_name: string | null;
    updated_at: string | null;
  };
  can_edit: boolean;
};

const QUERY_KEY = ["quotation-terms-settings"];

export function QuotationTermsForm() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<{ warranty: string; delivery: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/admin/settings/quotation-terms");
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Failed to load quotation terms");
      }
      return json.data as Payload;
    },
  });

  const saved = data
    ? { warranty: data.settings.warranty, delivery: data.settings.delivery }
    : { warranty: "", delivery: "" };
  const form = draft ?? saved;
  const dirty =
    draft !== null && (draft.warranty !== saved.warranty || draft.delivery !== saved.delivery);
  const canEdit = !!data?.can_edit;

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings/quotation-terms", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Save failed");
      }
      setDraft(null);
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success("Saved. New quotations will carry these terms.");
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
        Loading quotation terms…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="py-8 text-sm text-red-600">
        {error instanceof Error ? error.message : "Failed to load quotation terms"}
      </div>
    );
  }

  const field = (key: "warranty" | "delivery", label: string) => (
    <label className="block">
      <span className="text-xs font-medium text-ink">{label}</span>
      <textarea
        value={form[key]}
        disabled={!canEdit}
        rows={2}
        maxLength={500}
        onChange={(e) => setDraft({ ...form, [key]: e.target.value })}
        className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand-teal disabled:opacity-70"
      />
    </label>
  );

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-ink">Quotation terms</h3>
        <p className="mt-1 text-xs text-ink-muted">
          Every quotation prints these warranty and delivery terms. Reps choose only the dealer
          payment terms (cash, or credit with days) and whether the end customer needs NBFC
          finance; any credit sends the quote for approval.
        </p>
      </div>

      {field("warranty", "Warranty")}
      {field("delivery", "Delivery")}

      {data.settings.updated_at && (
        <p className="text-xs text-ink-muted">
          Last changed {new Date(data.settings.updated_at).toLocaleString("en-IN")}
          {data.settings.updated_by_name ? ` by ${data.settings.updated_by_name}` : ""}.
        </p>
      )}

      {canEdit ? (
        <div className="flex items-center gap-3">
          <Button
            onClick={save}
            disabled={!dirty || saving || form.warranty.trim().length < 3 || form.delivery.trim().length < 3}
          >
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
      ) : (
        <p className="text-xs text-ink-muted">Only admin or CEO can change these terms.</p>
      )}
    </div>
  );
}
