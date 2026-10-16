// quote_status — "has my quote been approved?" (gap table C). With a lead: its
// latest quote — version, total, approval (and the CEO's rejection reason),
// quote number, whether the PDF is ready, the product lines and terms (so a
// revision can start from them), the dealer's answer and the last send — plus
// the LIVE version (newest approved) that send_quote would send, and can_send
// from it. Timestamps go out as IST ("…+05:30").
// Without a lead: the user's own leads whose latest quote is waiting for the
// CEO or was rejected, as a tappable list.
//
// Scope first — out of scope ≡ not found (Invariant 1). A lead in scope but not
// owned is readable, like get_lead_details.

import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { MAX_TOOL_ROWS, type ToolResult } from "../../types";
import { defineTool, LeadId, scopedLeadOr, type ToolFactory } from "../spec";
import { leadUrl, queueUrl, toLeadSummary } from "../leads";
import { APPROVAL_LABEL, loadLatestQuote } from "../quotes";
import { istIso } from "../../format";
import { ownScopePredicate, scopeJoin, scopeTeam } from "../../scope";

export const quoteStatus: ToolFactory = () =>
    defineTool({
        name: "quote_status",
        kind: "read",
        description:
            "With lead_id: that lead's latest quote — approval status (approved / waiting for CEO / rejected + reason), " +
            "total, product lines, terms, quote number, PDF ready, dealer's answer, last send, and live_version = the approved " +
            "version a send would use (can_send). " +
            "Without lead_id: the user's own leads whose latest quote is waiting for the CEO or was rejected.",
        schema: z.object({ lead_id: LeadId.optional() }),
        run: async (ctx, input): Promise<ToolResult> => {
            if (!input.lead_id) {
                // The user's own scope (own tabs, a manager's team, own open
                // leads) — a subset of the read scope, so every row opens.
                const team = await scopeTeam(ctx.user);
                const visitCols =
                    ctx.user.role === "asm" ? sql`lv.scheduled_date::text AS scheduled_date, lv.visit_status,` : sql``;
                const rows = await db.execute<Record<string, unknown> & { id: string }>(sql`
                    SELECT dl.id, dl.shop_name, dl.dealer_name, dl.city, dl.phone, dl.lead_status, dl.interest_level,
                           dl.current_owner_id, owner.name AS current_owner_name, dl.last_touchpoint_at,
                           dl.next_follow_up_at, ${visitCols} q.approval_status,
                           count(*) OVER () AS total
                      FROM dealer_leads dl
                      ${scopeJoin(ctx.user)}
                      LEFT JOIN users owner ON owner.id::text = dl.current_owner_id
                      JOIN LATERAL (
                            SELECT c.approval_status, c.created_at
                              FROM dealer_lead_commercials c
                             WHERE c.dealer_lead_id = dl.id
                               AND c.event_type IN ('quote_issue', 'quote_revision')
                               AND c.withdrawn_at IS NULL
                             ORDER BY c.version_no DESC
                             LIMIT 1
                      ) q ON q.approval_status IN ('pending', 'rejected')
                     WHERE ${ownScopePredicate(ctx.user, team)}
                     ORDER BY q.created_at DESC
                     LIMIT ${MAX_TOOL_ROWS}
                `);
                return {
                    kind: "leads",
                    title: "Quotes waiting / rejected",
                    rows: rows.map((r) => {
                        // The quote's state is what this list is about.
                        const approval = APPROVAL_LABEL[String(r.approval_status)] ?? String(r.approval_status);
                        return { ...toLeadSummary(r, ctx.user), status: approval, status_label: approval };
                    }),
                    total: Number(rows[0]?.total ?? 0),
                    crm_url: queueUrl(ctx.user),
                };
            }

            const scoped = await scopedLeadOr(ctx, input.lead_id);
            if (scoped.result) return scoped.result;
            const lead = scoped.lead;
            const crmUrl = leadUrl(ctx.user, lead.id);
            // ID 60: the newest quote (what is being asked about) and the newest
            // APPROVED one (what send_quote would send) — a revision at the CEO
            // or rejected leaves the earlier approved version live.
            const [q, liveQ] = await Promise.all([loadLatestQuote(lead.id), loadLatestQuote(lead.id, "live")]);
            if (!q) {
                return {
                    kind: "quote",
                    quote: { lead_id: lead.id, shop_name: lead.shop_name, has_quote: false, crm_url: crmUrl },
                };
            }
            // The newest send attempt (listDispatches' table, read directly so
            // this read tool stays off the PDF / provider stack).
            const sends = await db.execute<{ channel: string; status: string; created_at: string | Date; sent_by_name: string | null }>(sql`
                SELECT d.channel, d.status, d.created_at, u.name AS sent_by_name
                  FROM quotation_dispatches d
                  LEFT JOIN users u ON u.id::text = d.sent_by
                 WHERE d.commercial_id = ${q.commercial_id}::uuid
                 ORDER BY d.created_at DESC
                 LIMIT 1
            `);
            const s0 = sends[0];
            const last = s0
                ? { channel: s0.channel, status: s0.status, created_at: istIso(s0.created_at), sent_by_name: s0.sent_by_name }
                : null;
            return {
                kind: "quote",
                quote: {
                    lead_id: lead.id,
                    shop_name: lead.shop_name ?? lead.dealer_name,
                    owned_by_you: lead.owned,
                    has_quote: true,
                    version: q.version_no,
                    kind: q.event_type === "quote_revision" ? "revision" : "first quote",
                    approval: APPROVAL_LABEL[q.approval_status ?? "approved"] ?? q.approval_status,
                    auto_approved: q.approval_mode === "auto",
                    rejection_reason: q.rejection_reason,
                    total: q.total,
                    quote_number: q.quote_number,
                    pdf_ready: q.pdf_ready,
                    // What send_quote would send: the live version, if its PDF is ready.
                    can_send: !!liveQ && liveQ.approval_status === "approved" && liveQ.pdf_ready,
                    live_version: liveQ
                        ? {
                              version: liveQ.version_no,
                              quote_number: liveQ.quote_number,
                              total: liveQ.total,
                              pdf_ready: liveQ.pdf_ready,
                              is_latest: liveQ.commercial_id === q.commercial_id,
                          }
                        : null,
                    product_lines: q.product_lines,
                    credit_terms: q.credit_terms,
                    delivery_terms: q.delivery_terms,
                    warranty_terms: q.warranty_terms,
                    payment_method: q.payment_method,
                    dealer_decision: q.dealer_decision,
                    dealer_decision_at: istIso(q.dealer_decision_at),
                    last_sent: last
                        ? { channel: last.channel, status: last.status, at: last.created_at, by: last.sent_by_name }
                        : null,
                    created_at: istIso(q.created_at),
                    crm_url: crmUrl,
                },
            };
        },
    });
