// Create a NeoDove campaign (E-224).
//
// A NeoDove campaign here is a MAPPING, not an engine. NeoDove has no campaign
// creation API, so the campaign must already exist on their side; what this
// form records is which audience of ours feeds it and which endpoint to send to.
//
// WHY THE ENDPOINT IS AN ENV VAR NAME AND NOT A URL. NeoDove issues no API key
// — the Custom Integration URL carries an opaque token and IS the write
// credential. Storing it in the database would mean a DB read grants write
// access to their system, so `push_endpoint_ref` holds the NAME of an env var
// and the server resolves it at push time.
//
// WHY THE OPERATOR NO LONGER TYPES THAT NAME. This was a free-text box, which
// was busywork when only one endpoint exists and actively harmful otherwise: a
// typo produced a campaign that looked wired and then failed at push time with
// "endpoint not found", far from the mistake. /api/neodove/endpoints reports
// which names are actually populated (names only, never values), so the choice
// is made from reality — auto-selected when there is one, a picker when there
// are several, and an honest warning when there are none.

"use client";

import { useEffect, useState } from "react";
import { X, CheckCircle2, AlertTriangle, Info } from "lucide-react";

type EndpointRef = { ref: string; kind: "push" | "update" };

const SEGMENTS: { value: "all" | "hot" | "warm" | "cold"; label: string; hint: string }[] =
    [
        { value: "all", label: "All", hint: "Every callable lead" },
        { value: "hot", label: "Hot", hint: "Highest measured intent" },
        { value: "warm", label: "Warm", hint: "Mid intent" },
        { value: "cold", label: "Cold", hint: "Low or never-called" },
    ];

/**
 * Existing campaign to edit. Absent = create mode.
 *
 * Editing exists because wiring the endpoint AFTER creating the campaign is the
 * normal case, not an edge one: the Custom Integration in NeoDove is usually
 * made later, and without an edit path a campaign created without one was
 * stuck "not wired" forever.
 */
export type EditableCampaign = {
    id: string;
    name: string;
    neodove_campaign_name: string | null;
    push_endpoint_ref: string | null;
    audience_filter?: unknown;
    mirror_config?: unknown;
    // E-226. Undefined on any DB without that migration — the list route reads
    // it through to_jsonb, so absent reads as "not the priority destination",
    // which is the correct default.
    // E-237, read the same way: absent reads as "no default CRM owner".
    crm_owner_user_id?: string | null;
};

type Assignee = {
    user_id: string;
    name: string | null;
    role: string | null;
};

// Both assignable roles are shown, and they behave differently — an ASM target
// lifts pushed leads to Transferred_to_ASM rather than Assigned_Not_Contacted —
// so the picker names the role rather than leaving two bare first names.
const ASSIGNEE_ROLE_LABEL: Record<string, string> = {
    inside_sales_rep: "Inside Sales Rep",
    asm: "ASM",
};

// Mirrors NeoDove's own "Pipeline" dropdown. Hard-coded because there is no API
// to read it — kept editable as free text below for exactly that reason.
const PIPELINES = ["Sales", "Ground Leads"];

const DISTRIBUTIONS: { value: string; label: string; hint: string }[] = [
    {
        value: "on_demand",
        label: "On Demand",
        hint: "Leads stay unassigned until an agent clicks Start Calling, then NeoDove assigns ten at a time.",
    },
    {
        value: "equal",
        label: "Equal distribution",
        hint: "NeoDove splits the leads evenly across the selected agents up front.",
    },
];

export function NeodoveCampaignModal({
    onClose,
    onCreated,
    campaign,
}: {
    onClose: () => void;
    onCreated: (id: string) => void;
    campaign?: EditableCampaign;
}) {
    const isEdit = Boolean(campaign);
    const [name, setName] = useState(campaign?.name ?? "");
    const [neodoveCampaignName, setNeodoveCampaignName] = useState(
        campaign?.neodove_campaign_name ?? "",
    );
    const [pushEndpointRef, setPushEndpointRef] = useState(
        campaign?.push_endpoint_ref ?? "",
    );
    const [category, setCategory] = useState<"all" | "hot" | "warm" | "cold">(
        ((campaign?.audience_filter as { category?: string } | undefined)
            ?.category as "all" | "hot" | "warm" | "cold") ?? "all",
    );
    // --- Mirror of NeoDove's own campaign settings (E-225) -------------------
    // Recorded, never applied. NeoDove has no campaign-creation API, so these
    // describe what a human set up in their UI.
    const mirror = (campaign?.mirror_config ?? {}) as {
        pipeline?: string;
        managedBy?: string;
        agents?: string[];
        leadDistribution?: string;
    };
    const [pipeline, setPipeline] = useState(mirror.pipeline ?? "");
    const [managedBy, setManagedBy] = useState(mirror.managedBy ?? "");
    const [agents, setAgents] = useState<string[]>(mirror.agents ?? []);
    const [agentDraft, setAgentDraft] = useState("");
    const [leadDistribution, setLeadDistribution] = useState(
        mirror.leadDistribution ?? "",
    );

    // --- CRM owner for pushed leads (E-237) — applied, not mirrored ----------
    const [crmOwnerUserId, setCrmOwnerUserId] = useState(
        campaign?.crm_owner_user_id ?? "",
    );
    const [assignees, setAssignees] = useState<Assignee[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetch("/api/neodove/assignees")
            .then((r) => r.json())
            .then((json) => {
                if (cancelled) return;
                setAssignees(
                    Array.isArray(json?.data?.assignees) ? json.data.assignees : [],
                );
            })
            .catch(() => {
                if (!cancelled) setAssignees([]);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    function addAgent() {
        const value = agentDraft.trim();
        // Case-insensitive dedupe: "Kapil" and "kapil" are one person, and a
        // duplicated chip would misrepresent how many agents work the campaign.
        if (
            !value ||
            agents.some((a) => a.toLowerCase() === value.toLowerCase())
        ) {
            setAgentDraft("");
            return;
        }
        setAgents((prev) => [...prev, value]);
        setAgentDraft("");
    }

    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // null = still loading. [] = none configured, which is a real state worth
    // showing rather than an empty picker.
    const [endpoints, setEndpoints] = useState<EndpointRef[] | null>(null);
    useEffect(() => {
        let cancelled = false;
        fetch("/api/neodove/endpoints")
            .then((r) => r.json())
            .then((json) => {
                if (cancelled) return;
                const all: EndpointRef[] = Array.isArray(json?.data?.endpoints)
                    ? json.data.endpoints
                    : [];
                const push = all.filter((e) => e.kind === "push");
                setEndpoints(push);
                // Exactly one configured endpoint is the common case — pick it
                // rather than making the operator retype what the server
                // already knows. Never override a value being edited.
                setPushEndpointRef((current) =>
                    current || push.length !== 1 ? current : push[0].ref,
                );
            })
            .catch(() => {
                if (!cancelled) setEndpoints([]);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const canSubmit = name.trim() !== "" && !saving;

    // A campaign can hold a ref that is no longer populated on this server —
    // renamed env var, or a config that exists on prod but not here. Silently
    // showing the one configured endpoint instead would display something
    // different from what gets saved, which is the exact "looks wired but
    // isn't" failure this rewrite set out to remove.
    const configuredRefs = (endpoints ?? []).map((e) => e.ref);
    const refMissing =
        endpoints !== null &&
        pushEndpointRef !== "" &&
        !configuredRefs.includes(pushEndpointRef);

    async function submit() {
        if (!canSubmit) return;
        setSaving(true);
        setError(null);
        try {
            // On EDIT an empty field means "clear it" and is sent as null; on
            // CREATE the key is omitted entirely, because the POST schema's
            // .min(1) would reject an empty string.
            // Only send the mirror when something was actually filled in.
            // An all-empty object would look like a recorded-and-blank NeoDove
            // setup rather than one nobody has documented yet — and on create
            // it would also name a column that may not exist yet (E-225).
            const pendingAgent = agentDraft.trim();
            const allAgents =
                pendingAgent &&
                !agents.some((a) => a.toLowerCase() === pendingAgent.toLowerCase())
                    ? [...agents, pendingAgent]
                    : agents;
            const mirrorConfig: Record<string, unknown> = {};
            if (pipeline.trim()) mirrorConfig.pipeline = pipeline.trim();
            if (managedBy.trim()) mirrorConfig.managedBy = managedBy.trim();
            if (allAgents.length) mirrorConfig.agents = allAgents;
            if (leadDistribution) mirrorConfig.leadDistribution = leadDistribution;
            const hasMirror = Object.keys(mirrorConfig).length > 0;
            if (hasMirror) mirrorConfig.observedAt = new Date().toISOString();

            const body: Record<string, unknown> = {
                name: name.trim(),
                audienceFilter: { category },
            };
            if (hasMirror) {
                body.mirrorConfig = mirrorConfig;
            } else if (isEdit) {
                // Clearing every field on an existing campaign means "this
                // mirror was wrong" — drop it rather than leave a stale record.
                body.mirrorConfig = null;
            }
            // crmOwnerUserId (E-237). On create the key is omitted when empty —
            // naming the column on a DB without E-237 would fail at PARSE time
            // and take campaign creation down, exactly as mirror_config would.
            // On edit an empty value is an explicit null: "stop auto-assigning".
            if (crmOwnerUserId) {
                body.crmOwnerUserId = crmOwnerUserId;
            } else if (isEdit) {
                body.crmOwnerUserId = null;
            }
            // isPriorityDial is deliberately never sent now that the checkbox is
            // gone. The API still accepts it (both routes keep their at-most-one
            // move logic), so nothing here needed to change server-side — this
            // form simply stops writing the flag, which also means it can no
            // longer trip the PARSE-time failure on a DB without E-226.
            if (isEdit) {
                body.neodoveCampaignName = neodoveCampaignName.trim() || null;
                body.pushEndpointRef = pushEndpointRef.trim() || null;
            } else {
                if (neodoveCampaignName.trim()) {
                    body.neodoveCampaignName = neodoveCampaignName.trim();
                }
                if (pushEndpointRef.trim()) {
                    body.pushEndpointRef = pushEndpointRef.trim();
                }
            }

            const res = await fetch(
                isEdit
                    ? `/api/neodove/campaigns/${campaign!.id}`
                    : "/api/neodove/campaigns",
                {
                    method: isEdit ? "PATCH" : "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                },
            );
            const json = await res.json();
            if (!json.success) {
                throw new Error(json.error?.message ?? "Could not save campaign");
            }
            onCreated(json.data.id);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not save campaign");
            setSaving(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl">
                <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-6 py-4">
                    <h2 className="text-base font-semibold text-gray-900">
                        {isEdit ? "Campaign settings" : "New NeoDove campaign"}
                    </h2>
                    <button
                        onClick={onClose}
                        className="text-gray-400 hover:text-gray-600"
                        aria-label="Close"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700">
                            Campaign name
                        </label>
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Dealer outreach — Aug"
                            className="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
                        />
                        <p className="mt-1 text-xs text-gray-500">
                            How it appears in our CRM.
                        </p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700">
                            NeoDove campaign name
                        </label>
                        <input
                            value={neodoveCampaignName}
                            onChange={(e) => setNeodoveCampaignName(e.target.value)}
                            placeholder="CUSTOM_INTEGRATION-campaign"
                            className="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
                        />
                        <p className="mt-1 text-xs text-gray-500">
                            Exactly as it reads in NeoDove. Free text because NeoDove
                            exposes no campaign id over any API — this name is the only
                            human-checkable link between the two systems.
                        </p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700">
                            Push endpoint
                        </label>

                        {endpoints === null ? (
                            <p className="mt-1.5 text-sm text-gray-400">
                                Checking configured endpoints…
                            </p>
                        ) : endpoints.length === 0 ? (
                            <div className="mt-1.5 rounded-lg bg-amber-50 px-3 py-2.5">
                                <p className="flex items-start gap-2 text-xs text-amber-800">
                                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                    <span>
                                        No NeoDove push endpoint is configured on this
                                        server. Add the campaign&apos;s Custom Integration
                                        URL as an env var named{" "}
                                        <code className="font-mono">
                                            NEODOVE_PUSH_ENDPOINT_&lt;LABEL&gt;
                                        </code>{" "}
                                        and restart, then reopen this form. You can still
                                        create the campaign now — it just cannot push.
                                    </span>
                                </p>
                            </div>
                        ) : endpoints.length === 1 && !refMissing ? (
                            <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
                                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
                                <span className="font-mono text-sm text-emerald-900">
                                    {pushEndpointRef || endpoints[0].ref}
                                </span>
                                <span className="ml-auto text-[11px] text-emerald-700">
                                    auto-selected
                                </span>
                            </div>
                        ) : (
                            <select
                                value={pushEndpointRef}
                                onChange={(e) => setPushEndpointRef(e.target.value)}
                                className="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-gray-900 focus:outline-none"
                            >
                                <option value="">Not wired yet</option>
                                {endpoints.map((e) => (
                                    <option key={e.ref} value={e.ref}>
                                        {e.ref}
                                    </option>
                                ))}
                                {/* Keep the saved-but-unconfigured value selectable so
                                    opening this form cannot silently rewrite it. */}
                                {refMissing && (
                                    <option value={pushEndpointRef}>
                                        {pushEndpointRef} (not configured here)
                                    </option>
                                )}
                            </select>
                        )}

                        {refMissing && (
                            <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-700">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                <span>
                                    <strong className="font-mono">{pushEndpointRef}</strong>{" "}
                                    is saved on this campaign but is not set on this
                                    server, so pushes from here will fail. Pick a
                                    configured endpoint, or leave it if this campaign is
                                    only pushed from another environment.
                                </span>
                            </p>
                        )}

                        {endpoints !== null && endpoints.length > 0 && (
                            <p className="mt-1 text-xs text-gray-500">
                                {endpoints.length === 1
                                    ? "The only endpoint configured on this server, so it is used automatically."
                                    : "NeoDove generates one Custom Integration URL per campaign, so pick the one belonging to the campaign named above."}{" "}
                                Only the variable <strong>name</strong> is stored — the URL
                                is the sole credential NeoDove issues and never reaches the
                                database or the browser.
                            </p>
                        )}
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700">
                            Audience segment
                        </label>
                        <div className="mt-1.5 grid grid-cols-4 gap-2">
                            {SEGMENTS.map((s) => (
                                <button
                                    key={s.value}
                                    type="button"
                                    onClick={() => setCategory(s.value)}
                                    className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                                        category === s.value
                                            ? "border-gray-900 bg-gray-900 text-white"
                                            : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                                    }`}
                                    title={s.hint}
                                >
                                    {s.label}
                                </button>
                            ))}
                        </div>
                        <p className="mt-1 text-xs text-gray-500">
                            Resolved through the same audience builder the AI dialer
                            uses, so leads Inside Sales or an ASM are actively working
                            are excluded automatically (BRD §0.2). Nothing is sent yet —
                            you preview the exact count on the next screen before
                            pushing.
                        </p>
                    </div>

                    {/* The "Priority dial destination" checkbox stood here. It
                        existed solely to tell the per-lead "Call now" button
                        which campaign to push into; that button was removed from
                        the lead rows, so this control had nothing left to
                        configure and a checkbox that changes no observable
                        behaviour is worse than no checkbox. */}

                    {/* ── CRM owner for pushed leads (E-237) ─────────────────
                        DELIBERATELY OUTSIDE the mirror block below. Everything
                        in that block is "recorded, never applied"; this field
                        IS applied — every push into this campaign assigns its
                        leads to this person. Putting it inside would make that
                        block's banner untrue, which is the one thing it exists
                        to prevent. */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700">
                            Assign pushed leads in CRM to
                        </label>
                        <select
                            value={crmOwnerUserId}
                            onChange={(e) => setCrmOwnerUserId(e.target.value)}
                            className="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
                        >
                            <option value="">— Nobody (leave unassigned) —</option>
                            {(assignees ?? []).map((a) => (
                                <option key={a.user_id} value={a.user_id}>
                                    {a.name ?? a.user_id}
                                    {a.role ? ` · ${ASSIGNEE_ROLE_LABEL[a.role.toLowerCase()] ?? a.role}` : ""}
                                </option>
                            ))}
                        </select>
                        <p className="mt-1 text-xs text-gray-500">
                            The CRM counterpart of this campaign&apos;s NeoDove
                            assignee — set the agent who actually calls inside
                            NeoDove&apos;s own campaign settings, since they expose no
                            assignee API. Leads pushed here are assigned to this person
                            so they appear on their dashboard instead of nobody&apos;s.
                            Applies to future pushes only.
                        </p>
                    </div>

                    {/* ── Mirror of NeoDove's own campaign settings (E-225) ──
                        Everything below is RECORDED, not applied. NeoDove has
                        no campaign-creation API, so this cannot configure
                        anything on their side — it exists so a sales_head can
                        see who works a campaign without opening NeoDove. The
                        banner says so, because a form that looks authoritative
                        and is not is exactly how this integration has burned
                        us before. */}
                    <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-4 space-y-4">
                        <div className="flex items-start gap-2">
                            <Info className="w-4 h-4 shrink-0 mt-0.5 text-gray-400" />
                            <p className="text-xs text-gray-600">
                                <strong className="text-gray-800">
                                    Recorded from NeoDove — not applied.
                                </strong>{" "}
                                NeoDove has no campaign API, so the campaign itself is
                                created in their UI. Copy its settings here so they are
                                visible in the CRM. Editing these changes nothing in
                                NeoDove.
                            </p>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="block text-xs font-medium text-gray-700">
                                    Pipeline
                                </label>
                                <input
                                    list="neodove-pipelines"
                                    value={pipeline}
                                    onChange={(e) => setPipeline(e.target.value)}
                                    placeholder="Sales"
                                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
                                />
                                {/* datalist, not select: these are suggestions from
                                    NeoDove's UI today, and with no read API a new
                                    pipeline there must not be unenterable here. */}
                                <datalist id="neodove-pipelines">
                                    {PIPELINES.map((p) => (
                                        <option key={p} value={p} />
                                    ))}
                                </datalist>
                            </div>

                            <div>
                                <label className="block text-xs font-medium text-gray-700">
                                    Managed by
                                </label>
                                <input
                                    value={managedBy}
                                    onChange={(e) => setManagedBy(e.target.value)}
                                    placeholder="Chirag Garg"
                                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
                                />
                            </div>
                        </div>

                        <div>
                            <label className="block text-xs font-medium text-gray-700">
                                Agents
                            </label>
                            {agents.length > 0 && (
                                <div className="mt-1.5 flex flex-wrap gap-1.5">
                                    {agents.map((a) => (
                                        <span
                                            key={a}
                                            className="inline-flex items-center gap-1 rounded-full bg-white border border-gray-300 px-2.5 py-1 text-xs text-gray-700"
                                        >
                                            {a}
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    setAgents((prev) =>
                                                        prev.filter((x) => x !== a),
                                                    )
                                                }
                                                className="text-gray-400 hover:text-gray-700"
                                                aria-label={`Remove ${a}`}
                                            >
                                                <X className="w-3 h-3" />
                                            </button>
                                        </span>
                                    ))}
                                </div>
                            )}
                            <input
                                value={agentDraft}
                                onChange={(e) => setAgentDraft(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === ",") {
                                        e.preventDefault();
                                        addAgent();
                                    }
                                }}
                                onBlur={addAgent}
                                placeholder="Type a name and press Enter"
                                className="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
                            />
                            <p className="mt-1 text-xs text-gray-500">
                                Free text on purpose — NeoDove exposes no way to fetch its
                                user list, and a hand-maintained dropdown would go stale
                                silently whenever someone joins or leaves.
                            </p>
                        </div>

                        <div>
                            <label className="block text-xs font-medium text-gray-700">
                                Lead distribution
                            </label>
                            <select
                                value={leadDistribution}
                                onChange={(e) => setLeadDistribution(e.target.value)}
                                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
                            >
                                <option value="">Not recorded</option>
                                {DISTRIBUTIONS.map((d) => (
                                    <option key={d.value} value={d.value}>
                                        {d.label}
                                    </option>
                                ))}
                            </select>
                            {leadDistribution && (
                                <p className="mt-1 text-xs text-gray-500">
                                    {
                                        DISTRIBUTIONS.find(
                                            (d) => d.value === leadDistribution,
                                        )?.hint
                                    }
                                </p>
                            )}
                        </div>
                    </div>

                    {error && (
                        <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
                            {error}
                        </p>
                    )}
                </div>

                <div className="flex shrink-0 justify-end gap-2 border-t border-gray-100 px-6 py-4">
                    <button
                        onClick={onClose}
                        className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={submit}
                        disabled={!canSubmit}
                        className="rounded-lg bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                    >
                        {saving
                            ? "Saving…"
                            : isEdit
                              ? "Save changes"
                              : "Create draft"}
                    </button>
                </div>
            </div>
        </div>
    );
}
