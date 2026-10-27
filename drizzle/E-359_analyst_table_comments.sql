-- =============================================================================
-- E-359 — AI ANALYST: A PLAIN-ENGLISH DESCRIPTION ON EVERY TABLE IT MAY READ
--          (27 Oct 2026 — "ask anything, no table picking")
-- =============================================================================
-- WHY.
--   The AI Analyst no longer asks the CEO / Sales Head to choose tables. The
--   agent now finds the tables each question needs, by matching the question
--   against every table's name, columns and comment (the agent's
--   app/agent/table_ranker.py), and shows the model a one-line index of every
--   table built from the same comment. Most of these tables had no comment, so
--   "revenue", "dealer", "calls" had nothing to match beyond column names.
--
-- WHAT.
--   COMMENT ON TABLE / VIEW for the tables and masked views analyst_ro may read
--   (scripts/_create-analyst-readonly-role.mjs ALLOWED + MASKED_VIEWS), and a
--   few COMMENT ON COLUMN where a status or amount is easy to misread.
--
--   ONLY WHERE THERE IS NO COMMENT YET. A table that already carries one (often
--   a developer's note, e.g. invoices, buyback_requests) keeps it untouched.
--   A table or column this database does not have is skipped.
--
-- Comments are catalog metadata: no data, no locks beyond a brief one on the
-- catalog row, nothing for schema.ts to mirror. Idempotent: a second run finds
-- every comment set and changes nothing.
--
-- AFTER APPLYING: press "Refresh" in the AI Analyst's iTarang database source
-- (or wait up to 6 h) so the agent re-reads the comments.
-- =============================================================================

DO $do$
DECLARE
    r record;
    rel regclass;
    kind "char";
BEGIN
    FOR r IN SELECT * FROM (VALUES
        -- leads & sales pipeline
        ('dealer_leads', 'Sales leads: prospective dealers (shops, distributors) the sales team works, one row per lead. lead_status is the stage (e.g. Hot/Won/Converted/Lost); created_at = when the lead came in; current_owner_id / assigned_to = the rep. Leads in, conversions, lost reasons and lead counts by city, state, source or rep live here.'),
        ('dealer_lead_status_history', 'Every change of a dealer lead''s status (from_status -> to_status, changed_at). Use for when a lead was Won, Lost or moved stage; won_undone_at set = an undone Won.'),
        ('lead_assignments', 'Which rep owns or works a lead (lead_owner, lead_actor) and who assigned it, with times.'),
        ('lead_flow_events', 'Step-by-step events of a customer lead''s journey through the dealer flow (from_state -> to_state, by salesperson).'),
        ('lead_products', 'Products or product categories a customer lead is interested in.'),
        ('lead_visits', 'Field visits by ASMs (area sales managers) to dealer leads: scheduled and actual visit date, visit_status (count only ''visited''), outcome, next action.'),
        ('lead_touchpoints', 'Every contact with a dealer lead: calls by the inside-sales team (touchpoint_type ''inside_sales_call''), AI dialer calls (''ai_call''), transfers to field (''asm_transfer''), with call status, duration, disposition and who performed it. Use for calls made, connected calls and rep activity.'),
        ('lead_escalations', 'Dealer leads escalated to management: urgency, status, CEO recommendation and resolution.'),
        ('dealer_lead_commercials', 'Quotations for dealer leads: one row per quote version with price quoted, final price, terms, product lines, approval status and quote number. is_current = latest version.'),
        ('deals', 'Customer deals: products, totals incl. GST, payment term, deal_status and invoice number for a customer lead.'),
        ('dealers', 'Onboarded dealers (dealer companies) with onboarding status, activation date, finance_enabled and dealer_type.'),
        ('dealer_subscriptions', 'Dealer subscription plans: plan name, status, start and expiry.'),
        ('sales_targets', 'Monthly sales targets per person and metric. A person''s target = ceo_target + admin_addon; only status ''pushed'' or ''accepted'' count. Custom metrics use manual_actual.'),
        ('sales_target_versions', 'History of changes to a sales target (old and new values, who changed it and when).'),
        ('manual_dealer_sales', 'Dealer sales entered by hand: date, product, quantity, amount, invoice number.'),
        ('asm_territories', 'Which ASM (area sales manager) covers which state and city, and from when to when.'),
        ('region_groups', 'Named groups of regions used for reporting.'),
        ('states', 'Indian states and union territories (code, name).'),
        ('cities', 'Cities with their state code and coordinates.'),
        ('user_reporting_lines', 'Dated history of who reports to whom (user_id -> manager_id, effective_from / effective_to). Use for team-level answers on a date.'),
        -- AI dialer & campaigns
        ('ai_call_logs', 'AI voice-dialer calls to leads, one row per call: status, call_status, duration, intent score, band, next action, cost. Use for AI call volumes, outcomes and cost.'),
        ('bolna_calls', 'Calls placed through the Bolna AI voice provider: status, duration, phase and timings per lead.'),
        ('call_records', 'Recorded calls with sentiment, status and duration per lead.'),
        ('call_sessions', 'Call sessions started for a lead: provider, who initiated it, status and duration.'),
        ('dialer_campaigns', 'AI dialer calling campaigns: name, status, region filter, leads in it, calls made, completed and failed leads, schedule window and retries.'),
        ('dialer_campaign_leads', 'Each lead inside an AI dialer campaign: queue position, status (completed = the dealer spoke), attempts, intent score and call id.'),
        ('campaigns', 'Marketing campaigns (WhatsApp / SMS / email style): audience size, sent, delivered and failed counts, cost, schedule.'),
        ('campaign_segments', 'Saved audience segments for campaigns: rules, filters and estimated audience.'),
        ('ecofy_lead_activities', 'Activity log for Ecofy (solar) leads: what was done and its sync state.'),
        -- scraper
        ('scraper_leads', 'Raw leads found by the web scraper, with city and source.'),
        ('scraped_dealer_leads', 'Dealer leads found by the scraper, with location, business type, products sold, quality score, exploration status and converted_lead_id if it became a dealer lead.'),
        ('scraper_runs', 'Each scraper run: when, status, how many found, new leads saved, duplicates and invalid phones skipped.'),
        -- revenue, orders, expenses
        ('zoho_invoices', 'Sales invoices from Zoho Books (older revenue, frozen since the move to Vyapar): invoice date, total incl. GST, balance, status. Revenue = zoho_invoices + sales_invoices - credit_notes, skipping voids.'),
        ('sales_invoices', 'Sales invoices after the move off Zoho (Vyapar, read from Google Drive): invoice date, total incl. GST, amount paid, status. Revenue = zoho_invoices + sales_invoices - credit_notes, skipping voids.'),
        ('invoice_line_items', 'Line items of sales invoices (Zoho, Vyapar and credit notes): item, product_class (e.g. battery), product_id, quantity, rate, amount_excl_gst. Batteries sold = SUM(quantity) where product_class = ''battery''; credit-note lines (source ''credit'') are negative.'),
        ('invoice_voids', 'Invoices or credit notes that were voided (source + invoice_id). Leave these out of revenue and order counts.'),
        ('credit_notes', 'Credit notes issued against invoices: issue date and total. Subtracted from revenue; never an order.'),
        ('invoice_lines', 'Per-SKU lines of a deal invoice, matched against the deal''s locked lines.'),
        ('proforma_invoice_lines', 'Lines of a proforma invoice.'),
        ('orders', 'Orders placed with OEMs for dealer accounts: items, total amount, payment and delivery status and dates.'),
        ('purchase_order_lines', 'Lines of a purchase order: quantity, price and tax.'),
        ('expense_submissions', 'Staff expense claims: category, amount, expense date, status, who submitted and who approved, department, bucket. Use for spend and expenses.'),
        ('vyapar_item_map', 'Maps a Vyapar invoice item name to a CRM product and asset type (Item mapping).'),
        -- dealer accounts
        ('accounts', 'Dealer accounts after onboarding (live customers): business, city, state, status, owner (account_owner_id) and activation date. Live dealers = analyst_account_flags.is_dealer and no account_closures row.'),
        ('account_ownership', 'Current owner of each dealer account, who onboarded it and how it came in (came_through, source lead).'),
        ('account_owner_history', 'Who owned a dealer account on which dates (effective_from / effective_to). A salesperson''s revenue = invoices of accounts they owned on the invoice date.'),
        ('account_closures', 'Dealer accounts closed by hand (lost / closed dealer). A row means closed.'),
        ('time_limit_settings', 'Time limits such as idle_cc and idle_asm (working days before a lead counts as idle); the latest row by effective_from is in force.'),
        ('holiday_calendar', 'Company holidays; active ones are skipped when counting working days.'),
        -- inventory & products
        ('inventory', 'Stock: one row per battery / charger unit (serial_number), with product, OEM, status (in stock, allocated, sold...), dealer it went to, sold_at and inventory_amount (unit cost).'),
        ('inventory_events', 'History of each stock unit''s status changes (from_status -> to_status, when, by whom).'),
        ('inventory_transfers', 'Stock moved between dealers: serials, status and acknowledgement.'),
        ('products', 'Product catalogue: name, SKU, voltage, capacity, price, warranty, asset type.'),
        ('product_categories', 'Product categories.'),
        ('product_master_batteries', 'Battery models: voltage, capacity, chemistry, warranty, compatible chargers, GST rate.'),
        ('product_master_chargers', 'Charger models: output voltage and current, compatible batteries, base price, warranty.'),
        ('deployed_assets', 'Batteries deployed with end customers: serial, dealer, deployment date, payment, health, warranty and service dates.'),
        ('after_sales_records', 'After-sales cases for a sold battery: warranty, payment mode, status, opened and closed.'),
        ('service_tickets', 'Service tickets on deployed assets: issue type, priority, status, SLA deadline and breach, resolution.'),
        ('oems', 'Battery and charger manufacturers (OEMs) iTarang buys from.'),
        -- buyback
        ('buyback_deals', 'Buyback deals: the offer for a buyback request, its status and locked total.'),
        ('buyback_lines', 'Lines of a buyback batch: battery brand, chemistry, quantity, condition, functional / non-functional counts, expected price per unit.'),
        ('buyback_units', 'Individual battery units in a buyback line, with status.'),
        ('buyback_batches', 'Batches of batteries within a buyback request, per pickup address.'),
        -- fleet / IoT
        ('battery_alerts', 'Alerts raised by IoT batteries: alert type, severity, value vs threshold, acknowledged.'),
        ('telemetry_daily_summary', 'Daily per-battery telemetry rollup: average / min state of charge, health, km driven, idle hours, charge sessions, BMS faults.'),
        ('device_battery_map', 'Which IoT device is fitted to which battery serial, with dealer, vehicle type, state, city and model.'),
        -- usage
        ('module_usage_daily', 'How much each CRM module was used per day (pings, sessions) by role bucket; no individual users.'),
        -- masked views (personal data withheld)
        ('analyst_leads', 'Customer (retail / borrower) leads brought in by dealers, with personal data withheld: customer code, dealer, city, state, status, KYC status, loan need, source. Not the same as dealer_leads (the sales pipeline of dealers).'),
        ('analyst_ecofy_leads', 'Ecofy (solar) customer leads with personal data withheld: stage, segment, temperature, source, product interest, city, state, owner.'),
        ('analyst_loan_files', 'Customer loans after disbursal (personal data withheld): amount, EMI, tenure, disbursed amount and date, paid, outstanding, overdue, loan status.'),
        ('analyst_loan_applications', 'Customer loan applications (personal data withheld): amount, EMI, NBFC, status, submitted, approved and disbursed dates.'),
        ('analyst_account_flags', 'Per dealer account: is_dealer (counts as a live dealer) and gstin_missing. Join on accounts.id = account_id.'),
        ('analyst_staff', 'CRM staff: user_id, name, role (e.g. sales_executive, asm, sales_head) and is_active. Join any owner / assigned_to / performed_by / user_id column to user_id for names and roles.')
    ) AS t(name, comment)
    LOOP
        rel := to_regclass('public.' || quote_ident(r.name));
        CONTINUE WHEN rel IS NULL OR obj_description(rel, 'pg_class') IS NOT NULL;
        SELECT relkind INTO kind FROM pg_class WHERE oid = rel;
        EXECUTE format(
            'COMMENT ON %s public.%I IS %L',
            CASE WHEN kind IN ('v', 'm') THEN 'VIEW' ELSE 'TABLE' END,
            r.name, r.comment
        );
    END LOOP;

    FOR r IN SELECT * FROM (VALUES
        ('dealer_leads', 'lead_status', 'Stage of the lead. Converted = onboarding approved (what targets and credit use); Won = the rep marked it won; Lost = lost (lost_reason says why).'),
        ('dealer_leads', 'created_at', 'When the lead came in (leads in = rows created in the period). IST calendar days.'),
        ('dealer_leads', 'interest_level', 'Rep-set temperature of the lead: hot, warm, cold.'),
        ('dealer_leads', 'lost_reason', 'Why the lead was lost.'),
        ('dealer_leads', 'closed_at', 'When the lead was converted or closed; dealers converted in a period = lead_status ''Converted'' with closed_at in it.'),
        ('invoice_line_items', 'amount_excl_gst', 'Line amount before GST. Invoice totals in zoho_invoices / sales_invoices include GST.'),
        ('invoice_line_items', 'source', 'Where the line came from: zoho, vyapar, or credit (a credit-note line, negative).'),
        ('zoho_invoices', 'total', 'Invoice total including GST.'),
        ('sales_invoices', 'total', 'Invoice total including GST.'),
        ('lead_touchpoints', 'touchpoint_type', 'inside_sales_call = a human call by a rep; ai_call = AI dialer; asm_transfer = handed to a field ASM.'),
        ('dialer_campaign_leads', 'status', 'completed = the dealer spoke on the call; other values are not reached, failed, queued and so on.')
    ) AS c(tbl, col, comment)
    LOOP
        rel := to_regclass('public.' || quote_ident(r.tbl));
        CONTINUE WHEN rel IS NULL;
        CONTINUE WHEN NOT EXISTS (
            SELECT 1 FROM pg_attribute
             WHERE attrelid = rel AND attname = r.col AND attnum > 0 AND NOT attisdropped
        );
        CONTINUE WHEN col_description(
            rel, (SELECT attnum FROM pg_attribute WHERE attrelid = rel AND attname = r.col)
        ) IS NOT NULL;
        EXECUTE format('COMMENT ON COLUMN public.%I.%I IS %L', r.tbl, r.col, r.comment);
    END LOOP;
END
$do$;
