"use client";

import { useState } from "react";
import { toast } from "sonner";
import { canDoEcofyAction, type EcofyAction } from "@/lib/ecofy/access";
import { runLeadAction, type EcofyCase } from "../client";

export interface TabProps {
    leadId: string;
    c: EcofyCase;
    viewer: { id: string; role: string };
    assignedTo: string | null;
    /** Refetch everything on the page after a change. */
    onDone: () => void;
}

export function useCan(p: Pick<TabProps, "viewer" | "assignedTo" | "c">) {
    return (action: EcofyAction) =>
        canDoEcofyAction(p.viewer, { assigned_to_user_id: p.assignedTo, stage: p.c.stage }, action);
}

/** Runs an action with a busy flag, a toast either way and a refresh on success. */
export function useRunner(leadId: string, onDone: () => void) {
    const [busy, setBusy] = useState(false);
    async function run<T = unknown>(label: string, body: Record<string, unknown>): Promise<T | undefined> {
        setBusy(true);
        try {
            const r = await runLeadAction<T>(leadId, body);
            toast.success(label);
            onDone();
            return r.result;
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Action failed");
            return undefined;
        } finally {
            setBusy(false);
        }
    }
    async function wrap(label: string, fn: () => Promise<unknown>): Promise<boolean> {
        setBusy(true);
        try {
            await fn();
            toast.success(label);
            onDone();
            return true;
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Action failed");
            return false;
        } finally {
            setBusy(false);
        }
    }
    return { busy, run, wrap };
}

export const pretty = (s: string | null | undefined) => (s ? s.replace(/_/g, " ").toLowerCase() : "—");
