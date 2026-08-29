import { db } from "@/lib/db";
import { aiCallLogs } from "@/lib/db/schema";
import { or, eq, sql, desc } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import {
  LEADS_PAGE_ROLES,
  LEAD_HISTORY_EXPORT_ROLES,
} from "@/lib/leads/access";
import Link from "next/link";
import { ArrowLeft, Phone, MapPin, User } from "lucide-react";
import { redirect } from "next/navigation";
import { LeadDetailClient } from "@/components/leads/lead-detail-client";
import {
  isExternalCallTouchpoint,
  normalizeCalls,
} from "@/lib/leads/normalizeCalls";
import {
  TouchpointTimeline,
  type LeadTouchpoint,
} from "@/components/leads/touchpoint-timeline";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({ params }: any) {
  // Was a bare requireAuth(), which only asked "is anyone signed in". /leads is
  // in no `sharedRouteAccess` entry and matches no `roleDashboards` prefix, so
  // middleware never role-gates it either (src/middleware.ts) — meaning every
  // signed-in dealer, scrap_vendor, nbfc_partner and service_engineer could
  // render this page and read a prospect's name, phone and full call history.
  // Its own /leads/[id]/edit sibling has always used this gate; the view page
  // simply never caught up.
  const user = await requireRole([...LEADS_PAGE_ROLES]);
  if (!user) redirect("/login");

  const { id } = await params;

  const lead = await db.query.dealerLeads.findFirst({
    where: (l, { eq }) => eq(l.id, id),
  });

  if (!lead) {
    return (
      <div className="p-10 text-center bg-white rounded-xl border m-8 text-gray-500">
        Lead not found
      </div>
    );
  }

  // Canonical call store is ai_call_logs (the campaign drawer, cost analytics and
  // backfill cron all read it). Match this lead's calls by id OR by phone
  // last-10-digits — webhook finalizers attribute by phone, not id, so a call can
  // land on a log row whose lead_id differs; dealer_leads.phone is unique so the
  // last-10 match is safe. follow_up_history is folded in for legacy coverage.
  const phoneLast10 = (lead.phone ?? "").replace(/\D/g, "").slice(-10);
  const logs = await db
    .select()
    .from(aiCallLogs)
    .where(
      or(
        eq(aiCallLogs.lead_id, id),
        phoneLast10.length === 10
          ? sql`right(regexp_replace(${aiCallLogs.phone_number}, '[^0-9]', '', 'g'), 10) = ${phoneLast10}`
          : sql`false`,
      ),
    )
    .orderBy(desc(sql`COALESCE(${aiCallLogs.started_at}, ${aiCallLogs.created_at})`));

  const history = (lead.follow_up_history as any[]) ?? [];
  // normalizeCalls is called AFTER the touchpoint query below, because external
  // (NeoDove) calls are a third source for it — see the note there.

  // Human/vendor touch history. Separate store from ai_call_logs on purpose:
  // ai_call_logs is what the DIALER did, lead_touchpoints is what the BUSINESS
  // did — inside-sales calls, WhatsApp, and every NeoDove disposition arriving
  // on the webhook. Until this query existed the page rendered none of it.
  //
  // Raw sql rather than the Drizzle object because performed_by is text while
  // users.id is uuid; the ::text cast on the join side matches the established
  // pattern in src/lib/admin/listQueries.ts.
  //
  // Wrapped because a missing relation fails a statement at PARSE time, taking
  // the whole page with it — the same class of failure that took the Campaigns
  // tab down when neodove_campaigns was named in a CTE on a DB without E-224.
  // lead_touchpoints (E-113) should exist everywhere, but this section is a
  // read-only display: degrading it to "no entries" is always better than a
  // 500 on the lead page.
  let touchpoints: LeadTouchpoint[] = [];
  try {
    touchpoints = await db.execute<LeadTouchpoint>(sql`
    SELECT t.touchpoint_id::text AS touchpoint_id,
           t.touchpoint_type,
           u.name AS performed_by_name,
           -- Emitted as an explicit UTC ISO string rather than a Date so the
           -- value crossing the server/client boundary has one unambiguous
           -- shape for new Date() to parse.
           to_char(t.performed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS performed_at,
           t.call_status,
           t.call_duration_sec,
           t.is_engaged,
           t.remarks,
           t.external_system,
           t.sync_method,
           -- E-226, read through to_jsonb for the same reason the whole query
           -- is wrapped in a try: naming a column that does not exist fails at
           -- PARSE time, so a direct t.recording_url would blank the ENTIRE
           -- timeline on any DB without E-226 rather than just omitting the
           -- recording. The jsonb lookup resolves at runtime and yields NULL.
           to_jsonb(t) ->> 'recording_url' AS recording_url,
           to_jsonb(t) ->> 'external_agent_name' AS external_agent_name,
           -- E-236, same to_jsonb treatment and the same reason.
           to_jsonb(t) ->> 'disposition' AS disposition,
           to_jsonb(t) ->> 'disposition_bucket' AS disposition_bucket,
           to_jsonb(t) ->> 'connect_status' AS connect_status
      FROM lead_touchpoints t
      LEFT JOIN users u ON u.id::text = t.performed_by
     WHERE t.dealer_lead_id = ${id}
     ORDER BY t.performed_at DESC
     LIMIT 200
  `);
  } catch (err) {
    console.error("[leads/[id]] touchpoint history unavailable:", err);
  }

  // A call made in NeoDove is a call. It lands in lead_touchpoints (never in
  // ai_call_logs — that table is what OUR dialer did, and the dialer cron sweeps
  // it), so Call History / Total Calls / Latest Status could not see it: the page
  // rendered "No calls made yet" directly above an Activity timeline entry
  // describing the call, which reads as the integration being broken.
  //
  // Reuses the rows already fetched above rather than issuing a second query.
  const externalCalls = touchpoints
    .filter((t) => isExternalCallTouchpoint(t))
    .map((t) => ({
      id: t.touchpoint_id,
      touchpoint_type: t.touchpoint_type,
      call_status: t.call_status,
      external_system: t.external_system,
      external_agent_name: t.external_agent_name,
      recording_url: t.recording_url,
      remarks: t.remarks,
      created_at: t.performed_at,
    }));
  const calls = normalizeCalls(logs, history, externalCalls);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto py-8 px-6">
        <Link
          href="/leads"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-6 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Leads
        </Link>

        {/* Header — light CRM card */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 mb-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-gray-900 truncate">
                {lead.shop_name || lead.dealer_name || "Unnamed Shop"}
              </h1>
              <p className="text-xs text-gray-400 mt-0.5 font-mono">{lead.id}</p>
            </div>
            <StatusBadge status={lead.current_status} />
          </div>

          <div className="flex flex-wrap gap-x-5 gap-y-2 mt-4 text-sm text-gray-600">
            <span className="inline-flex items-center gap-1.5">
              <User className="w-4 h-4 text-gray-400" />
              {lead.dealer_name || "—"}
            </span>
            <a
              href={lead.phone ? `tel:${lead.phone}` : undefined}
              className="inline-flex items-center gap-1.5 hover:text-gray-900"
            >
              <Phone className="w-4 h-4 text-gray-400" />
              {lead.phone || "—"}
            </a>
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="w-4 h-4 text-gray-400" />
              {lead.location || lead.city || "—"}
            </span>
          </div>
        </div>

        <LeadDetailClient calls={calls} lead={lead} />

        <div className="mt-6">
          <TouchpointTimeline
            touchpoints={touchpoints}
            leadId={id}
            canExport={(LEAD_HISTORY_EXPORT_ROLES as readonly string[]).includes(
              user.role,
            )}
          />
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  const map: Record<string, { label: string; cls: string }> = {
    hot: { label: "Hot", cls: "bg-red-50 text-red-700 border-red-200" },
    warm: { label: "Warm", cls: "bg-amber-50 text-amber-700 border-amber-200" },
    cold: { label: "Cold", cls: "bg-blue-50 text-blue-700 border-blue-200" },
    qualified: { label: "Qualified", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    disqualified: { label: "Disqualified", cls: "bg-gray-100 text-gray-500 border-gray-200" },
    new: { label: "New", cls: "bg-gray-100 text-gray-600 border-gray-200" },
  };
  const s = map[status?.toLowerCase() ?? ""] ?? {
    label: status ?? "Unknown",
    cls: "bg-gray-100 text-gray-500 border-gray-200",
  };
  return (
    <span className={`shrink-0 text-xs px-3 py-1 rounded-full border font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}
