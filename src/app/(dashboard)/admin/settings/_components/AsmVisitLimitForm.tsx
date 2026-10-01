"use client";

// Settings → ASM visit limit (tracker ID 77.1). Working days from Transfer to
// ASM to the first field visit before the lead shows on the admin dashboard's
// "Awaiting field visit past N working days" panel and the needs-attention list.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

type Payload = {
  settings: {
    days: number;
    updated_by_name: string | null;
    updated_at: string | null;
  };
  max: number;
  can_edit: boolean;
};

const QUERY_KEY = ["asm-visit-limit-settings"];

export function AsmVisitLimitForm() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/admin/settings/asm-visit-limit");
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Failed to load the ASM visit limit");
      }
      return json.data as Payload;
    },
  });

  const saved = data ? String(data.settings.days) : "";
  const value = draft ?? saved;
  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= (data?.max ?? 30);
  const dirty = draft !== null && draft !== saved;

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings/asm-visit-limit", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: parsed }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Save failed");
      }
      setDraft(null);
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success("Saved. The overdue-visit panel uses the new limit.");
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
        Loading the ASM visit limit…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="py-8 text-sm text-red-600">
        {error instanceof Error ? error.message : "Failed to load the ASM visit limit"}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-ink">Awaiting field visit limit</h3>
        <p className="mt-1 text-xs text-ink-muted">
          After a lead is transferred to an ASM, the first field visit is due within this
          many working days (Monday to Saturday). Past it, the lead is flagged on the admin
          dashboard and in Needs attention.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="number"
          min={1}
          max={data.max}
          step={1}
          value={value}
          disabled={!data.can_edit}
          onChange={(e) => setDraft(e.target.value)}
          className="w-24 rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand-teal disabled:opacity-60"
          aria-label="Working days to the first field visit"
        />
        <span className="text-sm text-ink-muted">working days</span>
      </div>
      {draft !== null && !valid && (
        <p className="text-xs text-red-600">Enter a whole number from 1 to {data.max}.</p>
      )}

      {data.can_edit ? (
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={!dirty || !valid || saving}>
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
        <p className="text-xs text-ink-muted">Only admin or sales head can change this limit.</p>
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
