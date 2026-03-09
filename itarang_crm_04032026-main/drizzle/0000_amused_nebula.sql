CREATE TABLE "approvals" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" varchar(255) NOT NULL,
	"level" integer NOT NULL,
	"approver_role" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"approver_id" uuid,
	"decision_at" timestamp,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" varchar(255) NOT NULL,
	"action" varchar(50) NOT NULL,
	"changes" jsonb,
	"performed_by" uuid NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"lead_id" varchar(255) NOT NULL,
	"products" jsonb NOT NULL,
	"line_total" numeric(12, 2) NOT NULL,
	"gst_amount" numeric(12, 2) NOT NULL,
	"transportation_cost" numeric(12, 2) DEFAULT '0' NOT NULL,
	"transportation_gst_percent" integer DEFAULT 18 NOT NULL,
	"total_payable" numeric(12, 2) NOT NULL,
	"deal_status" varchar(50) NOT NULL,
	"payment_term" varchar(20) NOT NULL,
	"credit_period_months" integer,
	"is_immutable" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Existing: CREATE TABLE "inventory"
--> statement-breakpoint
CREATE TABLE "lead_assignments" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"lead_id" varchar(255) NOT NULL,
	"lead_owner" uuid NOT NULL,
	"assigned_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Existing: CREATE TABLE "leads"
--> statement-breakpoint
-- Existing: CREATE TABLE "oem_contacts"
--> statement-breakpoint
CREATE TABLE "oem_inventory_for_pdi" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"provision_id" varchar(255) NOT NULL,
	"product_id" varchar(255) NOT NULL,
	"oem_id" varchar(255) NOT NULL,
	"serial_number" varchar(255),
	"pdi_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"pdi_record_id" varchar(255)
);
--> statement-breakpoint
-- Existing: CREATE TABLE "oems"
--> statement-breakpoint
-- Existing: CREATE TABLE "orders"
--> statement-breakpoint
CREATE TABLE "pdi_records" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"oem_inventory_id" varchar(255) NOT NULL,
	"provision_id" varchar(255) NOT NULL,
	"iot_imei_no" varchar(255),
	"physical_condition" text NOT NULL,
	"discharging_connector" varchar(20) NOT NULL,
	"charging_connector" varchar(20) NOT NULL,
	"productor_sticker" varchar(50) NOT NULL,
	"voltage" numeric(5, 2),
	"soc" integer,
	"latitude" numeric(10, 6) NOT NULL,
	"longitude" numeric(10, 6) NOT NULL,
	"pdi_status" varchar(20) NOT NULL,
	"failure_reason" text,
	"product_manual_url" text,
	"warranty_document_url" text,
	"service_engineer_id" uuid NOT NULL,
	"inspected_at" timestamp NOT NULL
);
--> statement-breakpoint
-- Existing: CREATE TABLE "product_catalog"
--> statement-breakpoint
-- Existing: CREATE TABLE "provisions"
--> statement-breakpoint
CREATE TABLE "slas" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"workflow_step" varchar(100) NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" varchar(255) NOT NULL,
	"assigned_to" uuid,
	"sla_deadline" timestamp NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"completed_at" timestamp,
	"escalated_to" uuid,
	"escalated_at" timestamp,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Existing: CREATE TABLE "users"
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Removed FKs for existing inventory
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_lead_owner_users_id_fk" FOREIGN KEY ("lead_owner") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Removed FKs for leads and oem_contacts
ALTER TABLE "oem_inventory_for_pdi" ADD CONSTRAINT "oem_inventory_for_pdi_product_id_product_catalog_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oem_inventory_for_pdi" ADD CONSTRAINT "oem_inventory_for_pdi_oem_id_oems_id_fk" FOREIGN KEY ("oem_id") REFERENCES "public"."oems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Removed FKs for oems and orders
ALTER TABLE "pdi_records" ADD CONSTRAINT "pdi_records_oem_inventory_id_oem_inventory_for_pdi_id_fk" FOREIGN KEY ("oem_inventory_id") REFERENCES "public"."oem_inventory_for_pdi"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdi_records" ADD CONSTRAINT "pdi_records_service_engineer_id_users_id_fk" FOREIGN KEY ("service_engineer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Removed FKs for product_catalog and provisions
ALTER TABLE "slas" ADD CONSTRAINT "slas_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slas" ADD CONSTRAINT "slas_escalated_to_users_id_fk" FOREIGN KEY ("escalated_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;