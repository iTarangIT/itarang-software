// E-393 — LinkedIn Outreach (tasks/linkedin-outreach-dev-plan.md). Mirrors
// drizzle/E-393_linkedin_outreach.sql, which is the source of truth. Kept in
// its own file and re-exported from schema.ts so the 14k-line schema does not
// grow a merge hotspot.
import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  varchar,
  jsonb,
  uuid,
  index,
  uniqueIndex,
  bigserial,
  primaryKey,
} from "drizzle-orm/pg-core";

export const liProviderCredentials = pgTable(
  "li_provider_credentials",
  {
    provider: varchar("provider", { length: 20 }).notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    last4: varchar("last4", { length: 8 }).notNull(),
    updated_by: uuid("updated_by"),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.provider, t.kind] }) }),
);

export const liAccounts = pgTable("li_accounts", {
  id: uuid("id").defaultRandom().primaryKey().notNull(),
  label: text("label").notNull(),
  provider: varchar("provider", { length: 20 }).default("unipile").notNull(),
  provider_account_id: text("provider_account_id"),
  status: varchar("status", { length: 16 }).default("pending").notNull(),
  status_reason: text("status_reason"),
  owner_user_id: uuid("owner_user_id"),
  warmup_started_at: timestamp("warmup_started_at", { withTimezone: true }),
  last_health_at: timestamp("last_health_at", { withTimezone: true }),
  last_polled_at: timestamp("last_polled_at", { withTimezone: true }),
  created_by: uuid("created_by"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const liSettings = pgTable("li_settings", {
  account_id: uuid("account_id").primaryKey().notNull(),
  invites_per_day: integer("invites_per_day").default(15).notNull(),
  messages_per_day: integer("messages_per_day").default(30).notNull(),
  gap_min_minutes: integer("gap_min_minutes").default(3).notNull(),
  gap_max_minutes: integer("gap_max_minutes").default(9).notNull(),
  send_start: varchar("send_start", { length: 5 }).default("10:00").notNull(),
  send_end: varchar("send_end", { length: 5 }).default("18:30").notNull(),
  send_days: varchar("send_days", { length: 20 }).default("1,2,3,4,5,6").notNull(),
  warmup_week1_invites: integer("warmup_week1_invites").default(5).notNull(),
  warmup_week2_invites: integer("warmup_week2_invites").default(10).notNull(),
  poll_interval_minutes: integer("poll_interval_minutes").default(45).notNull(),
  invite_expiry_days: integer("invite_expiry_days").default(21).notNull(),
  updated_by: uuid("updated_by"),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const liSearchRuns = pgTable(
  "li_search_runs",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    keywords: text("keywords").notNull(),
    filters: jsonb("filters").default({}).notNull(),
    account_id: uuid("account_id"),
    provider: varchar("provider", { length: 20 }).default("brightdata").notNull(),
    provider_job_id: text("provider_job_id"),
    status: varchar("status", { length: 12 }).default("queued").notNull(),
    error: text("error"),
    result_count: integer("result_count").default(0).notNull(),
    triggered_by: uuid("triggered_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    started_at: timestamp("started_at", { withTimezone: true }),
    finished_at: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({ statusIdx: index("li_search_runs_status_idx").on(t.status, t.created_at) }),
);

export const liProspects = pgTable(
  "li_prospects",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    profile_id: text("profile_id").notNull(),
    public_url: text("public_url").notNull(),
    provider_id: text("provider_id"),
    full_name: text("full_name"),
    first_name: text("first_name"),
    headline: text("headline"),
    company: text("company"),
    city: text("city"),
    source: varchar("source", { length: 16 }).default("brightdata").notNull(),
    raw_json: jsonb("raw_json"),
    do_not_contact: boolean("do_not_contact").default(false).notNull(),
    do_not_contact_reason: text("do_not_contact_reason"),
    lead_id: varchar("lead_id", { length: 50 }),
    connection_state: varchar("connection_state", { length: 12 }),
    connection_checked_at: timestamp("connection_checked_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    profileUniq: uniqueIndex("li_prospects_profile_uniq").on(t.profile_id),
    urlUniq: uniqueIndex("li_prospects_url_uniq").on(t.public_url),
  }),
);

export const liSearchResults = pgTable(
  "li_search_results",
  {
    run_id: uuid("run_id").notNull(),
    prospect_id: uuid("prospect_id").notNull(),
    fit_score: integer("fit_score"),
    fit_reason: text("fit_reason"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.run_id, t.prospect_id] }) }),
);

export const liAttachments = pgTable("li_attachments", {
  id: uuid("id").defaultRandom().primaryKey().notNull(),
  file_name: text("file_name").notNull(),
  content_type: text("content_type"),
  size_bytes: integer("size_bytes"),
  storage_path: text("storage_path").notNull(),
  storage_url: text("storage_url").notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  uploaded_by: uuid("uploaded_by"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const liCampaigns = pgTable("li_campaigns", {
  id: uuid("id").defaultRandom().primaryKey().notNull(),
  name: text("name").notNull(),
  account_id: uuid("account_id").notNull(),
  template: text("template").default("").notNull(),
  invite_note: text("invite_note"),
  attachment_id: uuid("attachment_id"),
  status: varchar("status", { length: 12 }).default("draft").notNull(),
  created_by: uuid("created_by"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const liApprovals = pgTable("li_approvals", {
  id: uuid("id").defaultRandom().primaryKey().notNull(),
  campaign_id: uuid("campaign_id").notNull(),
  template_hash: varchar("template_hash", { length: 64 }).notNull(),
  note_hash: varchar("note_hash", { length: 64 }).notNull(),
  attachment_hash: varchar("attachment_hash", { length: 64 }).notNull(),
  prospect_count: integer("prospect_count").notNull(),
  approved_by: uuid("approved_by"),
  approved_at: timestamp("approved_at", { withTimezone: true }).defaultNow().notNull(),
  voided_at: timestamp("voided_at", { withTimezone: true }),
  void_reason: text("void_reason"),
});

export const liCampaignProspects = pgTable(
  "li_campaign_prospects",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    campaign_id: uuid("campaign_id").notNull(),
    prospect_id: uuid("prospect_id").notNull(),
    state: varchar("state", { length: 16 }).default("selected").notNull(),
    rendered_message: text("rendered_message"),
    rendered_note: text("rendered_note"),
    missing_fields: text("missing_fields"),
    next_action_at: timestamp("next_action_at", { withTimezone: true }),
    attempts: integer("attempts").default(0).notNull(),
    last_error: text("last_error"),
    invite_sent_at: timestamp("invite_sent_at", { withTimezone: true }),
    accepted_at: timestamp("accepted_at", { withTimezone: true }),
    message_sent_at: timestamp("message_sent_at", { withTimezone: true }),
    seen_at: timestamp("seen_at", { withTimezone: true }),
    replied_at: timestamp("replied_at", { withTimezone: true }),
    stopped_reason: text("stopped_reason"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("li_campaign_prospects_uniq").on(t.campaign_id, t.prospect_id),
    dueIdx: index("li_campaign_prospects_due_idx").on(t.state, t.next_action_at),
  }),
);

export const liConversations = pgTable(
  "li_conversations",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    account_id: uuid("account_id").notNull(),
    provider_chat_id: text("provider_chat_id").notNull(),
    prospect_id: uuid("prospect_id"),
    campaign_id: uuid("campaign_id"),
    last_message_at: timestamp("last_message_at", { withTimezone: true }),
    last_inbound_at: timestamp("last_inbound_at", { withTimezone: true }),
    unread: boolean("unread").default(false).notNull(),
    sentiment: varchar("sentiment", { length: 12 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ chatUniq: uniqueIndex("li_conversations_chat_uniq").on(t.account_id, t.provider_chat_id) }),
);

export const liMessages = pgTable(
  "li_messages",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    conversation_id: uuid("conversation_id").notNull(),
    provider_message_id: text("provider_message_id").notNull(),
    direction: varchar("direction", { length: 8 }).notNull(),
    body: text("body"),
    attachment_name: text("attachment_name"),
    campaign_prospect_id: uuid("campaign_prospect_id"),
    sent_by: uuid("sent_by"),
    sent_at: timestamp("sent_at", { withTimezone: true }).notNull(),
    seen_at: timestamp("seen_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    providerUniq: uniqueIndex("li_messages_provider_uniq").on(t.provider_message_id),
    convIdx: index("li_messages_conv_idx").on(t.conversation_id, t.sent_at),
  }),
);

export const liOutbox = pgTable("li_outbox", {
  id: uuid("id").defaultRandom().primaryKey().notNull(),
  conversation_id: uuid("conversation_id").notNull(),
  body: text("body").notNull(),
  attachment_id: uuid("attachment_id"),
  status: varchar("status", { length: 10 }).default("queued").notNull(),
  error: text("error"),
  created_by: uuid("created_by"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  sent_at: timestamp("sent_at", { withTimezone: true }),
});

export const liActionLog = pgTable(
  "li_action_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    account_id: uuid("account_id"),
    action: varchar("action", { length: 24 }).notNull(),
    ok: boolean("ok").notNull(),
    prospect_id: uuid("prospect_id"),
    campaign_id: uuid("campaign_id"),
    detail: text("detail"),
    actor_id: uuid("actor_id"),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ capsIdx: index("li_action_log_caps_idx").on(t.account_id, t.action, t.at) }),
);
