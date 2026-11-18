"use client";

// ID 77 "Visit not needed", moved out of AsmLeadActionBar unchanged (ID 246) so
// the action bar and the Next step box press the same thing: a reason of at
// least 5 characters, POST /api/asm/lead/[id]/visit-not-needed.

import { useCallback, useState } from "react";
import { toast } from "sonner";

export function useVisitNotNeeded(leadId: string, onChanged?: () => void) {
    const [saving, setSaving] = useState(false);
    const run = useCallback(async () => {
        const reason = window.prompt("Why is a field visit not needed? (at least 5 characters)")?.trim();
        if (!reason) return;
        if (reason.length < 5) {
            toast.error("Give a reason of at least 5 characters.");
            return;
        }
        setSaving(true);
        try {
            const res = await fetch(`/api/asm/lead/${encodeURIComponent(leadId)}/visit-not-needed`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reason }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Could not save");
            toast.success("Visit marked not needed.");
            onChanged?.();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setSaving(false);
        }
    }, [leadId, onChanged]);
    return { visitNotNeeded: run, savingNotNeeded: saving };
}
