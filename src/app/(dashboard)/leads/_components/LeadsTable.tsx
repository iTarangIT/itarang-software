"use client";

// The merged leads table — one row per lead, carrying BOTH halves of what used
// to be two screens: the oversight columns from /admin/leads-info (stage, owner,
// ASM, latest visit, last touch) and the action cluster from /leads (Bolna,
// ElevenLabs, NeoDove, View, Edit).
//
// Row click opens the drawer. That is load-bearing, not decoration: middleware
// bounces non-rep roles away from /inside-sales/lead/[id], so an admin has no
// other way to manage a lead in place.

import Link from "next/link";
import {
    AlertCircle,
    Clock,
    Inbox,
    Loader2,
    Phone,
    PhoneCall,
    RefreshCw,
    Store,
} from "lucide-react";
// NOTE: @/components/leads/call-button, NOT the older (dashboard)/leads/CallButton.tsx
// — only this one takes `provider` and `onCallStart`, which the dialer needs.
import { CallButton } from "@/components/leads/call-button";
import { SendToNeodoveButton } from "@/components/leads/send-to-neodove-button";
import { NeodoveTag } from "@/components/leads/neodove-tag";
import { SentByStamp } from "@/components/leads/sent-by-stamp";
// TYPE-ONLY — both modules import `db`; a value import here would pull the
// postgres driver into the client bundle. Runtime constants come from
// @/lib/leads/campaign, which has no dependencies at all.
import type { LeadCampaign } from "@/lib/leads/leadCampaign";
import type { LeadAssignedBy } from "@/lib/leads/leadAssignedBy";
import {
    CAMPAIGN_SYSTEM_LABEL,
    type CampaignSystem,
} from "@/lib/leads/campaign";
import { formatIdle, idleDays, idleSeverity, type IdleSeverity } from "@/lib/leads/idle";
import { StatusChip } from "@/app/(dashboard)/inside-sales/_components/StatusChip";
import { LeadCallStatus } from "@/components/leads/lead-call-status";
import type { LeadStatus } from "@/lib/lifecycle/transitions";
import { VISIT_OUTCOME_LABELS, type VisitOutcome } from "@/lib/asm/types";
import {
    INTENT_BUCKET_LABEL,
    INTENT_BUCKET_TONE,
    intentBucketOf,
} from "@/lib/leads/intentBucket";
import {
    DISPOSITION_BUCKET_TONE,
    DISPOSITION_NEUTRAL_TONE,
    isDispositionBucket,
} from "@/lib/leads/dispositions";
import type { LeadsCapabilities } from "@/lib/leads/access";
import type { LeadListRow } from "@/lib/leads/leadListQuery";

// Statuses where calling is pointless or forbidden. Carried over verbatim from
// the pre-merge Leads tab.
const NO_CALL_STATUSES = ["stop", "completed", "dnc", "failed"];

const CHIP_BASE =
    "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap";

const OUTCOME_TONE: Record<VisitOutcome, string> = {
    productive: "bg-emerald-50 text-emerald-700 border-emerald-200",
    commercials_progressed: "bg-sky-50 text-sky-700 border-sky-200",
    dealer_not_present: "bg-gray-50 text-gray-600 border-gray-200",
    dealer_uninterested: "bg-rose-50 text-rose-700 border-rose-200",
    scheduling_issue: "bg-amber-50 text-amber-700 border-amber-200",
    other: "bg-gray-50 text-gray-600 border-gray-200",
};

function pretty(value: string | null | undefined): string {
    if (!value) return "—";
    return value.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDate(iso: string | null): string {
    if (!iso) return "—";
    try {
        return new Date(iso).toLocaleDateString("en-IN", {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "short",
            day: "2-digit",
        });
    } catch {
        return "—";
    }
}

// Idle is a warning, not a status — muted until it is worth reading, then loud.
// Thresholds live in lib/leads/idle.ts; these are only their colours.
const IDLE_TONE: Record<IdleSeverity, string> = {
    fresh: "text-gray-600",
    watch: "text-amber-700",
    stale: "text-orange-700 font-semibold",
    cold: "text-rose-700 font-semibold",
};

const CAMPAIGN_SYSTEM_TONE: Record<CampaignSystem, string> = {
    ai_dialer: "border-violet-200 bg-violet-50 text-violet-700",
    neodove: "border-sky-200 bg-sky-50 text-sky-700",
};

function formatNextCall(date: string | null): string | null {
    if (!date) return null;
    const diff = new Date(date).getTime() - Date.now();
    if (diff < 0) return "Overdue";
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `in ${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `in ${hrs}h`;
    return `in ${Math.floor(hrs / 24)}d`;
}

export type LeadRow = LeadListRow & {
    neodove_sync_status?: string | null;
    /** Latest campaign this lead belongs to, either system. See leadCampaign.ts. */
    campaign?: LeadCampaign | null;
    /** Who handed this lead to its current owner. Null for non-oversight roles. */
    assigned_by?: LeadAssignedBy | null;
    // E-236. Read in a separate, failure-tolerant statement by the API route —
    // absent, not null, on a database without the migration.
    last_disposition?: string | null;
    last_disposition_bucket?: string | null;
    last_connect_status?: string | null;
};

type Props = {
    rows: LeadRow[];
    loading: boolean;
    caps: LeadsCapabilities;
    hasFilters: boolean;
    selected: Set<string>;
    onToggle: (id: string) => void;
    onToggleAll: () => void;
    onOpen: (lead: LeadRow) => void;
    onRefresh: () => void;
    onCallStart: (leadId: string) => void;
    /** Live dialer state for the row currently being called. */
    dialerLeadId: string | null;
    dialerPhase: "idle" | "calling" | "countdown";
    countdown: number;
    endedLeadIds: Set<string>;
};

export function LeadsTable({
    rows,
    loading,
    caps,
    hasFilters,
    selected,
    onToggle,
    onToggleAll,
    onOpen,
    onRefresh,
    onCallStart,
    dialerLeadId,
    dialerPhase,
    countdown,
    endedLeadIds,
}: Props) {
    // The checkbox column only earns its place if the viewer can act in bulk.
    const selectable = caps.canBulkAct || caps.canSendToNeodove;
    const allOnPageSelected =
        rows.length > 0 && rows.every((r) => selected.has(r.id));
    // Fixed columns: Dealer/Shop, Phone, Region, Qualification, Intent,
    // Visit/Outcome, Last Touch, Idle, Campaign/Created, Actions = 10. Then the
    // optional checkbox and the optional Owner + ASM pair. Used by the loading
    // and empty rows.
    const colSpan = 10 + (selectable ? 1 : 0) + (caps.canSeeOwnerAsm ? 2 : 0);
    // Pinned once per render so every row's idle figure is measured against the
    // same instant — and so the map callback stays pure (react-hooks/purity).
    // eslint-disable-next-line react-hooks/purity
    const nowMs = Date.now();

    return (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead className="bg-gray-50/60 text-[11px] uppercase tracking-wide text-gray-500">
                        <tr className="align-middle">
                            {selectable && (
                                <th className="w-10 px-4 py-3 text-left font-semibold">
                                    <input
                                        type="checkbox"
                                        aria-label="Select all on this page"
                                        checked={allOnPageSelected}
                                        onChange={onToggleAll}
                                        className="cursor-pointer"
                                    />
                                </th>
                            )}
                            <th className="min-w-[200px] px-4 py-3 text-left font-semibold">
                                Dealer / Shop
                            </th>
                            <th className="min-w-[140px] px-4 py-3 text-left font-semibold">
                                Phone
                            </th>
                            <th className="min-w-[130px] px-4 py-3 text-left font-semibold">
                                Region
                            </th>
                            <th className="min-w-[150px] px-4 py-3 text-left font-semibold">
                                Qualification
                            </th>
                            <th className="min-w-[110px] px-4 py-3 text-left font-semibold">
                                Intent
                            </th>
                            {caps.canSeeOwnerAsm && (
                                <>
                                    <th className="min-w-[150px] px-4 py-3 text-left font-semibold">
                                        Owner
                                    </th>
                                    <th className="min-w-[120px] px-4 py-3 text-left font-semibold">
                                        ASM
                                    </th>
                                </>
                            )}
                            <th className="min-w-[140px] px-4 py-3 text-left font-semibold">
                                Visit / Outcome
                            </th>
                            <th className="min-w-[110px] px-4 py-3 text-left font-semibold">
                                Last Touch
                            </th>
                            <th
                                className="min-w-[90px] px-4 py-3 text-left font-semibold"
                                title="Calendar days since the last touchpoint — or since the lead was created, if it has never been touched"
                            >
                                Idle
                            </th>
                            <th className="min-w-[170px] px-4 py-3 text-left font-semibold">
                                Campaign / Created
                            </th>
                            <th className="min-w-[300px] px-4 py-3 text-right font-semibold">
                                Actions
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {loading && (
                            <tr>
                                <td
                                    colSpan={colSpan}
                                    className="px-4 py-12 text-center text-gray-400"
                                >
                                    <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                                    Loading leads…
                                </td>
                            </tr>
                        )}
                        {!loading && rows.length === 0 && (
                            <tr>
                                <td
                                    colSpan={colSpan}
                                    className="px-4 py-16 text-center text-gray-400"
                                >
                                    <Inbox className="mx-auto mb-2 h-8 w-8" />
                                    {hasFilters
                                        ? "No leads match these filters."
                                        : "No leads yet."}
                                </td>
                            </tr>
                        )}
                        {!loading &&
                            rows.map((row) => {
                                const outcome = row.visit_outcome as VisitOutcome | null;
                                const bucket = intentBucketOf(row.final_intent_score);
                                const noCall = NO_CALL_STATUSES.includes(
                                    row.current_status ?? "",
                                );
                                const callDisabled = noCall || !row.phone;
                                const isBeingCalled =
                                    dialerPhase === "calling" && dialerLeadId === row.id;
                                const isUpNext =
                                    dialerPhase === "countdown" && dialerLeadId === row.id;
                                const nextCall = formatNextCall(row.next_call_at);
                                const idle = idleDays(
                                    row.last_touchpoint_at,
                                    row.created_at,
                                    nowMs,
                                );
                                const idleText = formatIdle(idle);
                                return (
                                    <tr
                                        key={row.id}
                                        onClick={() => onOpen(row)}
                                        className={`cursor-pointer border-l-2 align-middle transition hover:bg-gray-50 ${
                                            isBeingCalled
                                                ? "border-emerald-500 bg-emerald-50/40"
                                                : isUpNext
                                                  ? "border-amber-400 bg-amber-50/40"
                                                  : "border-transparent hover:border-emerald-500"
                                        }`}
                                    >
                                        {selectable && (
                                            <td
                                                className="px-4 py-3 align-middle"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <input
                                                    type="checkbox"
                                                    aria-label={`Select ${row.dealer_name || row.shop_name || "lead"}`}
                                                    checked={selected.has(row.id)}
                                                    onChange={() => onToggle(row.id)}
                                                    className="cursor-pointer"
                                                />
                                            </td>
                                        )}

                                        <td className="px-4 py-3 align-middle">
                                            <div className="flex items-center gap-2">
                                                <span
                                                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                                                        isBeingCalled ? "bg-emerald-100" : "bg-gray-100"
                                                    }`}
                                                >
                                                    {isBeingCalled ? (
                                                        <PhoneCall className="h-3.5 w-3.5 animate-pulse text-emerald-600" />
                                                    ) : (
                                                        <Store className="h-3.5 w-3.5 text-gray-500" />
                                                    )}
                                                </span>
                                                <span className="min-w-0">
                                                    <span className="block truncate font-medium text-gray-900">
                                                        {row.shop_name ||
                                                            row.dealer_name ||
                                                            "(unnamed dealer)"}
                                                    </span>
                                                    {row.dealer_name && row.shop_name && (
                                                        <span className="mt-0.5 block truncate text-[11px] text-gray-500">
                                                            {row.dealer_name}
                                                        </span>
                                                    )}
                                                </span>
                                            </div>
                                            <div className="mt-1 flex flex-wrap items-center gap-1">
                                                {/* Persistent provenance, unlike the call-state chips
                                                    beside it. Renders nothing for a lead that has never
                                                    been to NeoDove, and nothing for a failed push. */}
                                                <NeodoveTag syncStatus={row.neodove_sync_status} />
                                                {isBeingCalled && <LeadCallStatus status="calling" />}
                                                {endedLeadIds.has(row.id) && (
                                                    <LeadCallStatus status="ended" />
                                                )}
                                                {isUpNext && (
                                                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                                                        <Clock className="h-3 w-3" /> Up next in{" "}
                                                        {countdown}s
                                                    </span>
                                                )}
                                            </div>
                                        </td>

                                        <td className="px-4 py-3 align-middle tabular-nums text-gray-700">
                                            {row.phone ? (
                                                <span className="inline-flex items-center gap-1">
                                                    <Phone className="h-3 w-3 text-gray-400" />
                                                    {row.phone}
                                                </span>
                                            ) : (
                                                <span className="inline-flex items-center gap-1 text-[11px] italic text-gray-400">
                                                    <AlertCircle className="h-3 w-3" /> No phone
                                                </span>
                                            )}
                                        </td>

                                        <td className="px-4 py-3 align-middle">
                                            <div className="text-sm text-gray-900">
                                                {row.city || row.location || "—"}
                                            </div>
                                            {row.state && (
                                                <div className="text-[11px] capitalize text-gray-500">
                                                    {row.state.toLowerCase()}
                                                </div>
                                            )}
                                        </td>

                                        <td className="px-4 py-3 align-middle">
                                            <StatusChip
                                                status={row.lead_status as LeadStatus | null}
                                                size="sm"
                                            />
                                        </td>

                                        <td className="px-4 py-3 align-middle">
                                            <span
                                                className={`${CHIP_BASE} ${INTENT_BUCKET_TONE[bucket]}`}
                                                title={`Intent score ${row.final_intent_score ?? 0}`}
                                            >
                                                {INTENT_BUCKET_LABEL[bucket]}
                                                <span className="ml-1 tabular-nums opacity-70">
                                                    {row.final_intent_score ?? 0}
                                                </span>
                                            </span>
                                            {(row.total_attempts ?? 0) > 0 && (
                                                <span className="mt-1 flex items-center gap-1 text-[11px] text-gray-400">
                                                    <RefreshCw className="h-3 w-3" />
                                                    {row.total_attempts}x
                                                </span>
                                            )}
                                        </td>

                                        {caps.canSeeOwnerAsm && (
                                            <>
                                                <td className="px-4 py-3 align-middle">
                                                    {row.current_owner_name ? (
                                                        <div className="space-y-1">
                                                            <div className="text-sm text-gray-800">
                                                                {row.current_owner_name}
                                                            </div>
                                                            {row.current_owner_role && (
                                                                <span
                                                                    className={`${CHIP_BASE} border-gray-200 bg-gray-50 text-gray-600`}
                                                                >
                                                                    {pretty(row.current_owner_role)}
                                                                </span>
                                                            )}
                                                            {/* Who handed it over. Sits under the
                                                                owner because the two only mean
                                                                anything as a pair — recipient above,
                                                                sender below. The same stamp now
                                                                renders on the rep and ASM queues. */}
                                                            <SentByStamp
                                                                assignedBy={row.assigned_by}
                                                                currentOwnerId={row.current_owner_id}
                                                            />
                                                        </div>
                                                    ) : (
                                                        <span className="text-[11px] italic text-gray-400">
                                                            Unassigned
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 align-middle text-sm text-gray-700">
                                                    {row.asm_name || (
                                                        <span className="text-[11px] italic text-gray-400">
                                                            —
                                                        </span>
                                                    )}
                                                </td>
                                            </>
                                        )}

                                        <td className="px-4 py-3 align-middle">
                                            {row.visit_status ? (
                                                <div className="space-y-1">
                                                    <div className="text-[11px] text-gray-600">
                                                        {pretty(row.visit_status)}
                                                    </div>
                                                    {outcome && (
                                                        <span
                                                            className={`${CHIP_BASE} ${OUTCOME_TONE[outcome]}`}
                                                        >
                                                            {VISIT_OUTCOME_LABELS[outcome]}
                                                        </span>
                                                    )}
                                                </div>
                                            ) : (
                                                <span className="text-[11px] italic text-gray-400">
                                                    No visit
                                                </span>
                                            )}
                                        </td>

                                        <td className="px-4 py-3 align-middle text-[11px] tabular-nums text-gray-600">
                                            {fmtDate(row.last_touchpoint_at)}
                                            {/* The call-centre disposition for the
                                                most recent call (E-236). It sits
                                                under Last Touch because it IS the
                                                last touch — and because a filter you
                                                cannot see on the row that matched it
                                                is indistinguishable from a broken
                                                filter. */}
                                            {row.last_disposition && (
                                                <span
                                                    className={`${CHIP_BASE} mt-1 ${
                                                        row.last_disposition_bucket &&
                                                        isDispositionBucket(
                                                            row.last_disposition_bucket,
                                                        )
                                                            ? DISPOSITION_BUCKET_TONE[
                                                                  row.last_disposition_bucket
                                                              ]
                                                            : DISPOSITION_NEUTRAL_TONE
                                                    }`}
                                                    title={
                                                        row.last_connect_status ===
                                                        "not_connected"
                                                            ? "Not connected"
                                                            : row.last_disposition_bucket
                                                              ? `Connected › ${row.last_disposition_bucket}`
                                                              : "Connected"
                                                    }
                                                >
                                                    {row.last_disposition}
                                                </span>
                                            )}
                                            {nextCall && (
                                                <span
                                                    className={`mt-1 flex items-center gap-1 ${
                                                        nextCall === "Overdue"
                                                            ? "text-rose-600"
                                                            : "text-purple-600"
                                                    }`}
                                                >
                                                    <Clock className="h-3 w-3" />
                                                    {nextCall}
                                                </span>
                                            )}
                                        </td>

                                        {/* Idle — how long this lead has been sitting.
                                            Days is the primary reading; the months line
                                            appears only once days stop being a quantity
                                            anyone can feel (see formatIdle). */}
                                        <td className="px-4 py-3 align-middle">
                                            <div
                                                className={`text-sm tabular-nums ${IDLE_TONE[idleSeverity(idle)]}`}
                                                title={
                                                    idle === null
                                                        ? "No touchpoint and no creation date"
                                                        : row.last_touchpoint_at
                                                          ? `${idle} days since the last touchpoint`
                                                          : `Never touched — ${idle} days since the lead was created`
                                                }
                                            >
                                                {idleText.primary}
                                            </div>
                                            {idleText.months && (
                                                <div className="text-[11px] tabular-nums text-gray-400">
                                                    {idleText.months}
                                                </div>
                                            )}
                                            {!row.last_touchpoint_at && idle !== null && (
                                                <div className="text-[10px] uppercase tracking-wide text-gray-400">
                                                    never touched
                                                </div>
                                            )}
                                        </td>

                                        {/* Campaign / Created — which campaign the lead
                                            belongs to (either system), and when the lead
                                            itself entered the CRM. */}
                                        <td className="px-4 py-3 align-middle">
                                            {row.campaign ? (
                                                <div
                                                    className="flex flex-col gap-1"
                                                    title={`${CAMPAIGN_SYSTEM_LABEL[row.campaign.system]} campaign · lead added ${fmtDate(row.campaign.joined_at)} · campaign created ${fmtDate(row.campaign.campaign_created_at)}`}
                                                >
                                                    <span className="line-clamp-2 text-[12px] font-medium text-gray-800">
                                                        {row.campaign.name}
                                                    </span>
                                                    <span
                                                        className={`${CHIP_BASE} w-fit ${CAMPAIGN_SYSTEM_TONE[row.campaign.system]}`}
                                                    >
                                                        {CAMPAIGN_SYSTEM_LABEL[row.campaign.system]}
                                                    </span>
                                                </div>
                                            ) : (
                                                <span className="text-[11px] italic text-gray-400">
                                                    No campaign
                                                </span>
                                            )}
                                            <div className="mt-1 text-[11px] tabular-nums text-gray-500">
                                                Created {fmtDate(row.created_at)}
                                            </div>
                                        </td>

                                        {/* Actions — stopPropagation so a button press
                                            never also opens the row drawer. */}
                                        <td
                                            className="px-4 py-3 align-middle"
                                            onClick={(e) => e.stopPropagation()}
                                        >
                                            <div className="flex flex-wrap items-center justify-end gap-1.5">
                                                <CallButton
                                                    leadId={row.id}
                                                    phone={row.phone ?? ""}
                                                    disabled={callDisabled}
                                                    provider="bolna"
                                                    onCallStart={onCallStart}
                                                />
                                                <CallButton
                                                    leadId={row.id}
                                                    phone={row.phone ?? ""}
                                                    disabled={callDisabled}
                                                    provider="elevenlabs"
                                                    onCallStart={onCallStart}
                                                />
                                                {caps.canSendToNeodove && (
                                                    <SendToNeodoveButton
                                                        leadId={row.id}
                                                        leadName={
                                                            row.shop_name ||
                                                            row.dealer_name ||
                                                            "this lead"
                                                        }
                                                        disabled={callDisabled}
                                                        syncStatus={row.neodove_sync_status ?? null}
                                                        onSent={onRefresh}
                                                    />
                                                )}
                                                <Link href={`/leads/${row.id}`}>
                                                    <button className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium transition-all hover:bg-gray-50">
                                                        View
                                                    </button>
                                                </Link>
                                                <Link href={`/leads/${row.id}/edit`}>
                                                    <button className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-500 transition-all hover:bg-gray-50">
                                                        Edit
                                                    </button>
                                                </Link>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
